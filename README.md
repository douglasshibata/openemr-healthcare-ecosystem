# OpenEMR Integrated Healthcare Ecosystem

An enterprise-grade, high-performance HealthTech ecosystem integrated with OpenEMR. This repository provides a complete, modern middle tier (API Gateway / Middleware) using Node.js (TypeScript/Express) with PostgreSQL for HIPAA/LGPD audit logging, Redis/BullMQ for asynchronous job processing (e.g. appointment scheduling), SMART on FHIR OAuth2 integration, and an advanced Medical AI Voice/Text clinical transcription engine.

---

## 🎯 OBJECTIVES & FEATURES
1. **Core EMR Sync:** Real-time and asynchronous integration with OpenEMR FHIR R4 API.
2. **SMART on FHIR Authentication:** Support for secure Patient and Clinician SMART OAuth2 flows (Authorization Code + PKCE, Client Credentials).
3. **Async Queue Subsystem:** Redis and BullMQ powered queue for handling intensive, non-blocking requests like high-volume `Appointment` creations.
4. **Relational Cache & Audit Logs:** PostgreSQL schema designed specifically for immutable audit trails (complying with HIPAA §164.312(b) and LGPD Art. 37).
5. **AI Speech/Text Extraction Module:** Dynamic clinical notes transcription parser extracting Anamnesis, ICD-10 Diagnoses, and Prescriptions into structured FHIR resources (`DocumentReference`, `Condition`, `MedicationRequest`).
6. **Data Masking (PII / PHI):** Zero-trust on-the-fly anonymization and RBAC protection.

---

## 1. SYSTEM ARCHITECTURE & DATA FLOW

### ASCII System Architecture

```
                  +-------------------------------------------------------------+
                  |                 PATIENT & CLINICIAN APPS                    |
                  |     (Patient Portal / Mobile React Native / Next.js Web)    |
                  +------------------------------+------------------------------+
                                                 |
                                     HTTPS / WSS / REST APIs
                                                 v
                  +-------------------------------------------------------------+
                  |                      CUSTOM MIDDLEWARE                      |
                  |                (API Gateway / NestJS / Express)             |
                  +-------+--------------------+--------------------+-----------+
                          |                    |                    |
             PostgreSQL   |                    | Redis/BullMQ       | JSON-RPC / REST
             (Port 5432)  |                    | (Port 6379)        |
                          v                    v                    v
                  +---------------+    +---------------+    +-------------------+
                  | AUDIT LOGS &  |    | ASYNC QUEUE   |    | CLINICAL AI       |
                  | LOCAL CACHE   |    | (Appointments)|    | PARSER & NLP      |
                  +---------------+    +---------------+    +-------------------+
                                               |
                                        Worker Polls Jobs
                                               v
                          SMART on FHIR REST API / OAuth2 / HTTPS
                                               |
                                               v
                  +-------------------------------------------------------------+
                  |                     OPENEMR PLATFORM                        |
                  |                                                             |
                  |   +--------------------+       +------------------------+   |
                  |   | OpenEMR FHIR R4    | <---> | Apache / PHP           |   |
                  |   | API Gateway Engine |       | (Core Clinical System) |   |
                  |   +--------------------+       +-----------+------------+   |
                  |                                            |                |
                  |                                    MySQL   | (Port 3306)    |
                  |                                            v                |
                  |                                +------------------------+   |
                  |                                | OpenEMR Database       |   |
                  |                                +------------------------+   |
                  +-------------------------------------------------------------+
```

### SMART on FHIR Authentication & Authorization Flow

SMART on FHIR profiles standard OAuth2.0 to protect health data. It specifies two primary flows:
1. **EHR Launch / Patient Access Flow (Authorization Code Flow with PKCE)**
2. **Backend Services Flow (Client Credentials with JWT Assertion)**

Below is the sequence diagram for the **Patient Access (PKCE)** flow:

```
Patient/Portal             Middleware Gateway               OpenEMR Auth (OAuth2)         OpenEMR FHIR API
      |                             |                                 |                          |
      | 1. Initiate Login           |                                 |                          |
      |---------------------------->|                                 |                          |
      |                             | 2. Generate Code Verifier/Chall |                          |
      |                             |    Redirect with challenge      |                          |
      |                             |-------------------------------->|                          |
      | 3. Render Login & Approve Scopes                              |                          |
      |<--------------------------------------------------------------|                          |
      |                             |                                 |                          |
      | 4. Redirect with Auth Code  |                                 |                          |
      |---------------------------->|                                 |                          |
      |                             | 5. Request Token (Code + Verifier)                         |
      |                             |-------------------------------->|                          |
      |                             |                                 |                          |
      |                             | 6. Return Access Token & ID     |                          |
      |                             |<--------------------------------|                          |
      |                             |                                                            |
      | 7. Request Resource (e.g. Patient info) with Bearer token                                |
      |----------------------------------------------------------------------------------------->|
      |                             |                                                            |
      | 8. Validate Token & Scope                                                                |
      |   (e.g., patient/Patient.read)                                                           |
      |<-----------------------------------------------------------------------------------------|
```

---

## 2. SECURITY, PRIVACY & COMPLIANCE (HIPAA / LGPD)

### A. HIPAA Compliance Security Controls (§164.308 to §164.312)
- **Access Control (§164.312(a)):** Users are authenticated and checked against strict Role-Based Access Control (RBAC).
- **Audit Controls (§164.312(b)):** All data mutation requests write an immutable audit entry to PostgreSQL capturing: `timestamp`, `operator_id`, `patient_id`, `action`, `resource_type`, `old_value`, `new_value`, and `ip_address`.
- **Integrity (§164.312(c)):** Signatures or SHA-256 hashes are used to verify audit trail integrity.
- **Transmission Security (§164.312(e)):** Complete end-to-end encryption using TLS 1.3.

### B. LGPD Protection Measures (Art. 37 & Art. 38)
- **Minimization & Anonymization:** PHI and PII (Patient Names, CPF, Phones, Emails) are dynamically masked at the gateway boundary unless the logged-in user possesses explicit clinical privileges (`role: CLINICIAN` or `role: AUDITOR`).
- **Data Subject Rights Support:** Dedicated APIs to export logs and request data purging on auxiliary cached systems.

---

## 3. OPENEMR SMART ON FHIR REST/OAUTH2 SETUP GUIDE

To enable communication between this Middleware and OpenEMR, you must configure OAuth2 clients:

1. **Access the OpenEMR Administrator Console:**
   - Log into OpenEMR as an Administrator.
   - Go to **Administration** -> **System** -> **API Client Registrations**.

2. **Register a New SMART client:**
   - Click **Add Client**.
   - **Client Name:** `Patient Portal Gateway`
   - **Redirect URIs:** `http://localhost:3000/auth/callback` (or your production URL).
   - **Token Endpoint Auth Method:** `private_key_jwt` or `client_secret_post` depending on your security architecture.
   - **Scope Selection:** Select FHIR scopes:
     - `openid`
     - `fhirUser`
     - `launch/patient`
     - `patient/Patient.read`
     - `patient/Patient.write`
     - `patient/Encounter.read`
     - `patient/Appointment.write`
     - `patient/Observation.read`
     - `patient/Observation.write`
     - `patient/Condition.write`
     - `patient/MedicationRequest.write`
     - `patient/DocumentReference.write`

3. **Retrieve Credentials:**
   - Copy the generated `Client ID` and `Client Secret` (if client_secret_post).
   - Place these credentials inside the `.env` configuration file of the Middleware.

---

## 4. ENVIRONMENT RUN BOOK

To spin up the entire integrated ecosystem, perform the following:

```bash
# 1. Clone this repository and enter the health ecosystem folder
cd openemr-healthcare-ecosystem

# 2. Duplicate the .env.example file
cp .env.example .env

# 3. Spin up the entire multi-container stack via Docker Compose
docker-compose up -d

# 4. Check services health
docker-compose ps
```

The gateway endpoints will be active on `http://localhost:3000`. You can now run tests or query patient data!
