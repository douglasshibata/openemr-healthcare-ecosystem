import { FHIRService } from './services/fhirService';
import { AuditService } from './services/auditService';
import { AIService } from './services/aiService';

describe('HealthTech Ecosystem Middleware Test Suite', () => {
  let fhirService: FHIRService;
  let auditService: AuditService;
  let aiService: AIService;

  beforeAll(() => {
    fhirService = new FHIRService();
    auditService = new AuditService();
    aiService = new AIService(fhirService);
  });

  describe('HIPAA / LGPD Dynamic PHI Masking', () => {
    it('should return unmasked patient records when accessed by a CLINICIAN role', () => {
      const patient = {
        resourceType: 'Patient',
        id: '123',
        birthDate: '1984-11-23',
        name: [{ family: 'Almeida', given: ['Mariana'] }],
        telecom: [{ system: 'phone', value: '+5511988887777' }]
      };

      const result = auditService.maskPatientPHI(patient, 'CLINICIAN');
      expect(result.name[0].family).toBe('Almeida');
      expect(result.telecom[0].value).toBe('+5511988887777');
      expect(result.birthDate).toBe('1984-11-23');
    });

    it('should mask PII/PHI (patient name, phones, birth year safe harbor) when accessed by a PATIENT or standard public role', () => {
      const patient = {
        resourceType: 'Patient',
        id: '123',
        birthDate: '1984-11-23',
        name: [{ family: 'Almeida', given: ['Mariana'] }],
        telecom: [{ system: 'phone', value: '+5511988887777' }]
      };

      const result = auditService.maskPatientPHI(patient, 'PATIENT');
      // Names masked
      expect(result.name[0].family).toBe('A***');
      expect(result.name[0].given[0]).toBe('M***');
      // Telecom hidden
      expect(result.telecom[0].value).toBe('***-***-****');
      // Birth date masked (HIPAA Safe harbor retains only year of birth)
      expect(result.birthDate).toBe('1984-**-**');
    });
  });

  describe('Medical AI Clinical Speech/Text Transcription Parser', () => {
    it('should automatically identify hypertension and prescribe Losartan when the transcription has matching keywords', () => {
      const rawText = 'Paciente queixando-se de dor na nuca, histórico de pressão alta na família. Solicitado controle de hipertensão e receitado losartana.';
      const summary = aiService.parseTranscript(rawText);

      expect(summary.diagnoses).toContainEqual(expect.objectContaining({
        code: 'I10',
        display: 'Essential (primary) hypertension'
      }));

      expect(summary.prescriptions).toContainEqual(expect.objectContaining({
        medication: 'Losartan potassium 50mg'
      }));
    });

    it('should fall back to safe headache defaults if transcription is vague or short', () => {
      const rawText = 'Paciente reclama de cefaleia.';
      const summary = aiService.parseTranscript(rawText);

      expect(summary.diagnoses[0].code).toBe('R51.9');
      expect(summary.prescriptions[0].medication).toBe('Paracetamol 500mg');
    });
  });

  describe('SMART on FHIR API Client Verification', () => {
    it('should properly generate a mock OAuth access token when API credentials are unconfigured/blank', async () => {
      const token = await fhirService.authenticate();
      expect(token).toBeDefined();
      expect(token).toBe('mock_smart_on_fhir_access_token_2026');
    });
  });
});
