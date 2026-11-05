const { orderAcceptanceApp } = require('./order-acceptance-app.cjs');
const { AuditModule } = require('../dist/src/audit-logs/audit.module');
const { UsersModule } = require('../dist/src/users/users.module');
const { FleetModule } = require('../dist/src/fleet/fleet.module');
const { VehiclesModule } = require('../dist/src/vehicles/vehicles.module');
const { DriversModule } = require('../dist/src/drivers/drivers.module');
const auditApp = (port = 0) => orderAcceptanceApp(port, [AuditModule, UsersModule, FleetModule, VehiclesModule, DriversModule]);
module.exports = { auditApp };
if (require.main === module) auditApp(4018).then(() => console.log('Audit test API ready')).catch(() => { console.error('Audit test API failed'); process.exitCode = 1; });
