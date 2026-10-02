import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { requestContextMiddleware, authenticateSession, requireSuperadmin, resolveTenantContext, requireCsrfProtection } from './middleware/tenantContext.js';
import { handleIdempotency } from './middleware/idempotency.js';
import { errorHandler } from './middleware/errorHandler.js';
import { pool } from './infrastructure/database/pool.js';

// Routers
import { authRouter } from './modules/auth/auth.routes.js';
import { platformRouter } from './modules/restaurants/platform.routes.js';
import { adminManagementRouter } from './modules/administrators/admin.routes.js';
import { configurationRouter } from './modules/configuration/configuration.routes.js';
import { employeeRouter } from './modules/employees/employee.routes.js';
import { schedulingRouter } from './modules/scheduling/scheduling.routes.js';
import { attendanceRouter } from './modules/attendance/attendance.routes.js';
import { warningRouter } from './modules/warnings/warning.routes.js';
import { adjustmentRouter } from './modules/adjustments/adjustment.routes.js';
import { debtRouter } from './modules/debt/debt.routes.js';
import { payrollRouter } from './modules/payroll/payroll.routes.js';
import { reportRouter } from './modules/reports/report.routes.js';

export function createApp(): Express {
  const app = express();

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  }));

  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Global Request Context
  app.use(requestContextMiddleware);

  // Health & Readiness checks
  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));
  app.get('/health/live', (_req, res) => res.json({ status: 'live' }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ready', database: 'connected' });
    } catch (err: any) {
      res.status(503).json({ status: 'not_ready', error: err.message });
    }
  });

  // Public / Auth routes
  app.use('/api/v1/auth', authRouter);

  // Platform routes (Superadmin only)
  app.use('/api/v1/platform', authenticateSession, requireSuperadmin, requireCsrfProtection, platformRouter);

  // Restaurant-scoped routes
  const restaurantRouter = express.Router({ mergeParams: true });
  restaurantRouter.use(authenticateSession);
  restaurantRouter.use(resolveTenantContext);
  restaurantRouter.use(handleIdempotency);
  restaurantRouter.use(requireCsrfProtection);

  restaurantRouter.use('/administrators', adminManagementRouter);
  restaurantRouter.use('/configuration', configurationRouter);
  restaurantRouter.use('/positions', configurationRouter);
  restaurantRouter.use('/deduction-types', configurationRouter);
  restaurantRouter.use('/shift-templates', configurationRouter);
  restaurantRouter.use('/employees', employeeRouter);
  restaurantRouter.use('/schedules', schedulingRouter);
  restaurantRouter.use('/attendance', attendanceRouter);
  restaurantRouter.use('/warnings', warningRouter);
  restaurantRouter.use('/adjustments', adjustmentRouter);
  restaurantRouter.use('/debt', debtRouter);
  restaurantRouter.use('/debt-waivers', debtRouter);
  restaurantRouter.use('/payroll', payrollRouter);
  restaurantRouter.use('/reports', reportRouter);
  restaurantRouter.use('/exports', reportRouter);

  app.use('/api/v1/restaurants/:restaurantId', restaurantRouter);

  // Centralized Error Handling
  app.use(errorHandler);

  return app;
}
