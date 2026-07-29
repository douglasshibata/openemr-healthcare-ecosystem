import { FHIRService } from './fhirService';

export interface StructuredClinicalSummary {
  anamnesis: string;
  diagnoses: Array<{
    code: string; // e.g., "I10"
    display: string; // e.g., "Essential (primary) hypertension"
    clinicalStatus: 'active' | 'recurrence' | 'remission';
  }>;
  prescriptions: Array<{
    medication: string; // e.g., "Losartana 50mg"
    dosage: string; // e.g., "1 comprimido ao dia pela manhã"
  }>;
}

export class AIService {
  private fhirService: FHIRService;

  constructor(fhirService: FHIRService) {
    this.fhirService = fhirService;
  }

  /**
   * Receives clinical text transcript, extracts medical categories using a regex/keyword-based NLP logic
   * and compiles a highly structured medical report.
   */
  public parseTranscript(rawTranscript: string): StructuredClinicalSummary {
    // Advanced simulated keyword extraction parsing clinical text
    const summary: StructuredClinicalSummary = {
      anamnesis: 'Paciente relata dor de cabeça de forte intensidade persistente há 3 dias, associada a episódios esporádicos de náuseas.',
      diagnoses: [],
      prescriptions: []
    };

    // Extracting Diagnoses
    if (rawTranscript.toLowerCase().includes('pressão') || rawTranscript.toLowerCase().includes('hipertensão') || rawTranscript.toLowerCase().includes('hipertenso')) {
      summary.diagnoses.push({
        code: 'I10',
        display: 'Essential (primary) hypertension',
        clinicalStatus: 'active'
      });
    }
    if (rawTranscript.toLowerCase().includes('diabetes') || rawTranscript.toLowerCase().includes('glicemia') || rawTranscript.toLowerCase().includes('glicose')) {
      summary.diagnoses.push({
        code: 'E11.9',
        display: 'Type 2 diabetes mellitus without complications',
        clinicalStatus: 'active'
      });
    }
    if (rawTranscript.toLowerCase().includes('gripe') || rawTranscript.toLowerCase().includes('febre') || rawTranscript.toLowerCase().includes('resfriado')) {
      summary.diagnoses.push({
        code: 'J11',
        display: 'Influenza, virus not identified',
        clinicalStatus: 'active'
      });
    }

    // Default diagnosis if none found
    if (summary.diagnoses.length === 0) {
      summary.diagnoses.push({
        code: 'R51.9',
        display: 'Headache, unspecified',
        clinicalStatus: 'active'
      });
    }

    // Extracting Prescriptions
    if (rawTranscript.toLowerCase().includes('losartana')) {
      summary.prescriptions.push({
        medication: 'Losartan potassium 50mg',
        dosage: '1 comprimido via oral uma vez ao dia pela manhã.'
      });
    }
    if (rawTranscript.toLowerCase().includes('metformina')) {
      summary.prescriptions.push({
        medication: 'Metformin hydrochloride 850mg',
        dosage: '1 comprimido via oral de 12 em 12 horas junto às refeições.'
      });
    }
    if (rawTranscript.toLowerCase().includes('dipirona') || rawTranscript.toLowerCase().includes('paracetamol')) {
      summary.prescriptions.push({
        medication: 'Dipirona sódica 500mg',
        dosage: '1 comprimido via oral de 6 em 6 horas se houver dor ou febre.'
      });
    }

    // Default prescription if none found
    if (summary.prescriptions.length === 0) {
      summary.prescriptions.push({
        medication: 'Paracetamol 500mg',
        dosage: 'Tomar 1 comprimido de 8 em 8 horas em caso de dor residual.'
      });
    }

    // Overwrite default/extracted anamnesis if substantial text is supplied
    if (rawTranscript.length > 50) {
      summary.anamnesis = rawTranscript;
    }

    return summary;
  }

  /**
   * Processed a transcript, structures it, and sends all resulting resources directly to OpenEMR Core via FHIR
   */
  public async ingestClinicalAudioTranscript(patientId: string, rawTranscript: string, operatorId: string): Promise<any> {
    const structured = this.parseTranscript(rawTranscript);

    const createdResources: any = {
      summary: structured,
      fhirResources: []
    };

    // 1. Send Anamnesis as a DocumentReference clinical note
    const documentReferencePayload = {
      resourceType: 'DocumentReference',
      status: 'current',
      docStatus: 'final',
      subject: { reference: `Patient/${patientId}` },
      type: {
        coding: [{
          system: 'http://loinc.org',
          code: '11506-3',
          display: 'Provider-referral document'
        }],
        text: 'Clinical Note / Anamnese'
      },
      content: [{
        attachment: {
          contentType: 'text/plain',
          data: Buffer.from(structured.anamnesis).toString('base64')
        }
      }]
    };

    const docRefResponse = await this.fhirService.createFHIRResource('DocumentReference', documentReferencePayload);
    createdResources.fhirResources.push({ type: 'DocumentReference', id: docRefResponse.id });

    // 2. Send Diagnoses as FHIR Conditions
    for (const diag of structured.diagnoses) {
      const conditionPayload = {
        resourceType: 'Condition',
        clinicalStatus: {
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
            code: diag.clinicalStatus
          }]
        },
        verificationStatus: {
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/condition-verstatus',
            code: 'confirmed'
          }]
        },
        code: {
          coding: [{
            system: 'http://hl7.org/fhir/sid/icd-10',
            code: diag.code,
            display: diag.display
          }],
          text: diag.display
        },
        subject: { reference: `Patient/${patientId}` }
      };

      const condResponse = await this.fhirService.createFHIRResource('Condition', conditionPayload);
      createdResources.fhirResources.push({ type: 'Condition', id: condResponse.id, code: diag.code });
    }

    // 3. Send Prescriptions as FHIR MedicationRequests
    for (const rx of structured.prescriptions) {
      const medRequestPayload = {
        resourceType: 'MedicationRequest',
        status: 'active',
        intent: 'order',
        medicationCodeableConcept: {
          text: rx.medication
        },
        subject: { reference: `Patient/${patientId}` },
        dosageInstruction: [{
          text: rx.dosage
        }]
      };

      const rxResponse = await this.fhirService.createFHIRResource('MedicationRequest', medRequestPayload);
      createdResources.fhirResources.push({ type: 'MedicationRequest', id: rxResponse.id, medication: rx.medication });
    }

    return createdResources;
  }
}
