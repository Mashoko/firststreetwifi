import { getConnectedClients } from '../src/services/omada.js';

const result = await getConnectedClients();
console.log(JSON.stringify(result, null, 2));
