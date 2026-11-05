const { orderAcceptanceApp } = require('./order-acceptance-app.cjs');
const { DashboardModule } = require('../dist/src/dashboard/dashboard.module');
const { VehiclesModule } = require('../dist/src/vehicles/vehicles.module');
const { DriversModule } = require('../dist/src/drivers/drivers.module');
orderAcceptanceApp(4018, [DashboardModule, VehiclesModule, DriversModule])
  .then(() => console.log('Order cancellation acceptance API ready'))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
