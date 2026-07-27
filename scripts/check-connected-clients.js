import { config } from '../src/config.js';
import { getConnectedClients } from '../src/services/omada.js';

console.error(config.mockMode ? '[MOCK MODE] fixture data, no controller contacted' : `[LIVE] ${config.omada.baseUrl}`);

const result = await getConnectedClients();
console.log(JSON.stringify(result, null, 2));
