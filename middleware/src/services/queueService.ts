import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import { FHIRService, FHIRAppointment } from './fhirService';
import { AuditService } from './auditService';

dotenv.config();

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';

// Initialize connection options for Redis
const connectionOpts = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD ? REDIS_PASSWORD : undefined,
  maxRetriesPerRequest: null, // Critical requirement for BullMQ
};

export class QueueService {
  private redisConnection: IORedis;
  private appointmentQueue: Queue;
  private appointmentWorker: Worker | null = null;
  private fhirService: FHIRService;
  private auditService: AuditService;

  constructor(fhirService: FHIRService, auditService: AuditService) {
    this.fhirService = fhirService;
    this.auditService = auditService;
    this.redisConnection = new IORedis(connectionOpts);

    this.appointmentQueue = new Queue('appointment-scheduling', {
      connection: this.redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000, // Wait 2s, 4s, 8s before failing
        },
        removeOnComplete: true,
      }
    });
  }

  /**
   * Adds an appointment scheduling request to the asynchronous Redis/BullMQ queue.
   */
  public async enqueueAppointment(appointment: FHIRAppointment, userId: string): Promise<string> {
    const job = await this.appointmentQueue.add('schedule', {
      appointment,
      userId,
    });

    // Write a system audit log of queuing the request
    const patientId = appointment.participant.find(p => p.actor.reference.startsWith('Patient/'))
      ?.actor.reference.split('/')[1] || 'unknown';

    await this.auditService.logAudit({
      operatorId: userId,
      patientId: patientId,
      action: 'QUEUE_APPOINTMENT_CREATION',
      resourceType: 'Appointment',
      oldValue: null,
      newValue: JSON.stringify({ jobId: job.id, appointment }),
      ipAddress: '127.0.0.1'
    });

    return job.id || 'unknown-job';
  }

  /**
   * Starts processing the queues with the Worker consumer
   */
  public startWorker(): void {
    if (this.appointmentWorker) {
      console.warn('Queue Worker is already running.');
      return;
    }

    console.log('Starting BullMQ Queue Worker for appointment scheduling...');

    this.appointmentWorker = new Worker(
      'appointment-scheduling',
      async (job: Job<{ appointment: FHIRAppointment; userId: string }>) => {
        const { appointment, userId } = job.data;
        console.log(`Processing Appointment Scheduling Job: ${job.id}`);

        // Call FHIR Service to sync / push to OpenEMR Core EMR
        const createdApt = await this.fhirService.createAppointment(appointment);

        // Extract patient identifier
        const patientId = appointment.participant.find(p => p.actor.reference.startsWith('Patient/'))
          ?.actor.reference.split('/')[1] || 'unknown';

        // Write audit log indicating the successfully synced appointment
        await this.auditService.logAudit({
          operatorId: userId,
          patientId: patientId,
          action: 'CREATE_APPOINTMENT_SYNC',
          resourceType: 'Appointment',
          oldValue: null,
          newValue: JSON.stringify(createdApt),
          ipAddress: '127.0.0.1'
        });

        console.log(`Successfully completed Appointment Job: ${job.id}. EMR ID: ${createdApt.id}`);
        return createdApt;
      },
      {
        connection: new IORedis(connectionOpts),
        concurrency: 5 // Process up to 5 concurrent creations
      }
    );

    this.appointmentWorker.on('failed', (job, err) => {
      console.error(`Job failed: ${job?.id} - Error: ${err.message}`);
    });
  }

  /**
   * Gracefully close all connections
   */
  public async close(): Promise<void> {
    if (this.appointmentWorker) {
      await this.appointmentWorker.close();
    }
    await this.appointmentQueue.close();
    this.redisConnection.disconnect();
  }
}
