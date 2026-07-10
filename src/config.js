import dotenv from 'dotenv';
dotenv.config();

const bool = (v, d = false) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  mockMode: bool(process.env.MOCK_MODE, true),

  paynow: {
    integrationId: process.env.PAYNOW_INTEGRATION_ID || '',
    integrationKey: process.env.PAYNOW_INTEGRATION_KEY || '',
    authEmail: process.env.PAYNOW_AUTH_EMAIL || '',
  },

  omada: {
    type: (process.env.OMADA_CONTROLLER_TYPE || 'software').toLowerCase(),
    baseUrl: (process.env.OMADA_BASE_URL || '').replace(/\/+$/, ''),
    controllerId: process.env.OMADA_CONTROLLER_ID || '',
    site: process.env.OMADA_SITE || 'Default',
    operatorUser: process.env.OMADA_OPERATOR_USER || '',
    operatorPass: process.env.OMADA_OPERATOR_PASS || '',
    verifyTls: bool(process.env.OMADA_VERIFY_TLS, false),
  },

  admin: {
    user: process.env.ADMIN_USER || '',
    password: process.env.ADMIN_PASSWORD || '',
  },
};
