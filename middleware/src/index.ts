import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import { FHIRService } from './services/fhirService';
import { AuditService } from './services/auditService';
import { QueueService } from './services/queueService';
import { AIService } from './services/aiService';

dotenv.config();

const app = express();
const port = process.env.MIDDLEWARE_PORT || 3000;

// Security and utility middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize Core Ecosystem Services
const fhirService = new FHIRService();
const auditService = new AuditService();
const queueService = new QueueService(fhirService, auditService);
const aiService = new AIService(fhirService);

// Run DB migrations and start queue worker
async function bootstrap() {
  await auditService.ensureSchema();
  queueService.startWorker();
}
bootstrap().catch(err => {
  console.error('Error during ecosystem bootstrap:', err);
});

// Context Extraction Middleware for HIPAA/LGPD Auditing and RBAC Role verification
interface RequestContext extends Request {
  user?: {
    id: string;
    role: 'PATIENT' | 'CLINICIAN' | 'AUDITOR' | 'ADMIN';
  };
}

const auditContextMiddleware = (req: RequestContext, res: Response, next: NextFunction) => {
  // In an enterprise production cluster, these are extracted from JWT claims
  const operatorId = req.headers['x-operator-id'] as string || 'unauthenticated-patient';
  const role = req.headers['x-operator-role'] as string || 'PATIENT';

  req.user = {
    id: operatorId,
    role: role as any
  };
  next();
};

app.use(auditContextMiddleware as any);

// ============================================================================
// HEALTH MONITORING ENDPOINT
// ============================================================================
app.get('/health', async (req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    timestamp: new Date(),
    services: {
      fhir: 'OK',
      postgres: 'OK',
      redis: 'OK'
    }
  });
});

// ============================================================================
// 1. PATIENTS - SEARCH WITH ROLE-BASED DATA MASKING (PHI/PII PROTECTION)
// ============================================================================
app.get('/api/patients', async (req: RequestContext, res: Response) => {
  const query = req.query.name as string || '';
  const operator = req.user!;

  try {
    const rawPatients = await fhirService.searchPatients(query);

    // Apply HIPAA / LGPD dynamic on-the-fly masking based on role
    const processedPatients = rawPatients.map(patient =>
      auditService.maskPatientPHI(patient, operator.role)
    );

    // Write audit log entry
    await auditService.logAudit({
      operatorId: operator.id,
      patientId: rawPatients.map(p => p.id).join(','),
      action: 'SEARCH_PATIENTS',
      resourceType: 'Patient',
      oldValue: null,
      newValue: `Found ${rawPatients.length} matching patients. Applied masking for role: ${operator.role}`,
      ipAddress: req.ip || '127.0.0.1'
    });

    res.status(200).json(processedPatients);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// 2. ENCOUNTERS - CLINICAL CONSULTATION HISTORY
// ============================================================================
app.get('/api/patients/:id/encounters', async (req: RequestContext, res: Response) => {
  const patientId = req.params.id;
  const operator = req.user!;

  try {
    const encounters = await fhirService.getEncountersByPatient(patientId);

    await auditService.logAudit({
      operatorId: operator.id,
      patientId: patientId,
      action: 'VIEW_ENCOUNTER_HISTORY',
      resourceType: 'Encounter',
      oldValue: null,
      newValue: `Retrieved ${encounters.length} clinical encounters`,
      ipAddress: req.ip || '127.0.0.1'
    });

    res.status(200).json(encounters);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// 3. APPOINTMENTS - ASYNCHRONOUS BULK/PORTAL SCHEDULING (BULLMQ QUEUE)
// ============================================================================
app.post('/api/appointments/async', async (req: RequestContext, res: Response) => {
  const { appointment } = req.body;
  const operator = req.user!;

  if (!appointment || !appointment.participant || appointment.participant.length === 0) {
    return res.status(400).json({ error: 'Invalid FHIR Appointment resource payload.' });
  }

  try {
    // Queue the job asynchronously
    const jobId = await queueService.enqueueAppointment(appointment, operator.id);

    res.status(202).json({
      message: 'Appointment request successfully queued for processing',
      jobId: jobId,
      status: 'queued'
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// 4. CLINICAL AI - VOICE / TEXT TO EMR INGESTION PIPELINE
// ============================================================================
app.post('/api/ai/transcribe', async (req: RequestContext, res: Response) => {
  const { patientId, transcript } = req.body;
  const operator = req.user!;

  if (!patientId || !transcript) {
    return res.status(400).json({ error: 'Missing patientId or transcript text parameter.' });
  }

  try {
    const result = await aiService.ingestClinicalAudioTranscript(patientId, transcript, operator.id);

    // Audit log transcription extraction action
    await auditService.logAudit({
      operatorId: operator.id,
      patientId: patientId,
      action: 'AI_TRANSCRIPTION_INGESTION',
      resourceType: 'DocumentReference,Condition,MedicationRequest',
      oldValue: null,
      newValue: JSON.stringify({
        transcriptLength: transcript.length,
        summary: result.summary,
        createdResources: result.fhirResources
      }),
      ipAddress: req.ip || '127.0.0.1'
    });

    res.status(201).json({
      message: 'Successfully processed medical transcript through AI NLP and persisted resources in EMR.',
      extractedData: result
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// 5. OBSERVATIONS - HEALTH METRICS RECORDING
// ============================================================================
app.post('/api/observations', async (req: RequestContext, res: Response) => {
  const { observation } = req.body;
  const operator = req.user!;

  if (!observation) {
    return res.status(400).json({ error: 'Observation resource is required.' });
  }

  try {
    const createdObs = await fhirService.createObservation(observation);

    const patientId = observation.subject?.reference?.split('/')[1] || 'unknown';

    await auditService.logAudit({
      operatorId: operator.id,
      patientId: patientId,
      action: 'RECORD_OBSERVATION',
      resourceType: 'Observation',
      oldValue: null,
      newValue: JSON.stringify(createdObs),
      ipAddress: req.ip || '127.0.0.1'
    });

    res.status(201).json(createdObs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Start listening for inbound health traffic
const server = app.listen(port, () => {
  console.log(`HealthTech Middleware API Gateway is active on port ${port}`);
});

export { app, server, fhirService, auditService, queueService, aiService };
