import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { initSchema } from './db/index.js';
import { portalRouter } from './routes/portal.js';
import { payRouter } from './routes/pay.js';
import { loginRouter } from './routes/login.js';
import { adminRouter } from './routes/admin/index.js';
import { lineChart, horizontalBarChart, sparkline } from './lib/charts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

initSchema();

const app = express();
app.locals.lineChart = lineChart;
app.locals.horizontalBarChart = horizontalBarChart;
app.locals.sparkline = sparkline;
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1000 * 60 * 60 }, // 1h
}));

app.use('/', portalRouter);
app.use('/pay', payRouter);
app.use('/login', loginRouter);
app.use('/admin', adminRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong loading this page.' });
});

app.listen(config.port, () => {
  console.log(`\n🌐 First Street WiFi running at ${config.baseUrl}`);
  console.log(`   Portal:  ${config.baseUrl}/`);
  console.log(`   Admin:   ${config.baseUrl}/admin`);
  console.log(`   Mode:    ${config.mockMode ? 'MOCK (no real Omada/Paynow calls)' : 'LIVE'}\n`);
});
