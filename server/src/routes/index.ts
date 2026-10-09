import type { FastifyInstance } from 'fastify';
import { adminRoutes } from './admin.js';
import { authRoutes } from './auth.js';
import { automationRoutes } from './automations.js';
import { catalogRoutes } from './catalog.js';
import { conversationRoutes } from './conversations.js';
import { dashboardRoutes } from './dashboard.js';
import { eventsRoutes } from './events.js';
import { integrationRoutes } from './integrations.js';
import { leadRoutes } from './leads.js';
import { opportunityRoutes } from './opportunities.js';
import { pipelineRoutes } from './pipelines.js';
import { publicRoutes } from './public.js';
import { reportRoutes } from './reports.js';
import { taskRoutes } from './tasks.js';
import { userRoutes } from './users.js';
import { webhookRoutes } from './webhooks.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(pipelineRoutes);
  await app.register(leadRoutes);
  await app.register(opportunityRoutes);
  await app.register(taskRoutes);
  await app.register(conversationRoutes);
  await app.register(integrationRoutes);
  await app.register(automationRoutes);
  await app.register(dashboardRoutes);
  await app.register(reportRoutes);
  await app.register(eventsRoutes);
  await app.register(publicRoutes);
  await app.register(webhookRoutes);
}
