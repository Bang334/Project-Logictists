const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
let schema = fs.readFileSync(schemaPath, 'utf8');

const keep = new Set(`
User Branch Location UserRoleScope AuditLog OutboxEvent ProcessedCommand Notification
Category Product Sku StockBalance StockLedgerEntry InventoryReservation StockReceipt StockReceiptLine StockAdjustment StockAdjustmentLine
Customer CustomerAddress Order OrderItem OrderStop OrderEvent SalesInvoice SalesInvoiceLine FeedbackCase FeedbackMessage CollectionToken
Package TransferShipment TripTransferShipment Employee AttendanceEntry EmployeeLeave Driver DriverLicense DriverActivityEvent Vehicle
VehicleUnavailability MaintenanceRecord FuelLog GpsEvent WorkPolicy ResourceReservation Trip TripStop DriverAssignment StopTask
DeliveryAttempt PodFile Incident IncidentOrder LoadPlan LoadPlanStep LoadPlacement ExecutionEvent OptimizationJob OptimizationResult
PayrollPeriod PayrollRun PayrollItem CostEntry
`.trim().split(/\s+/));

const existingModels = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
const removed = existingModels.filter((name) => !keep.has(name));

for (const name of removed) {
  schema = schema.replace(new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}\\r?\\n?`, 'm'), '');
}

// Remove relation fields that pointed at deleted models. Scalar columns are cleaned
// in the explicit replacements below or retained only when they are useful snapshots.
for (const name of removed) {
  schema = schema.replace(new RegExp(`^\\s*\\w+\\s+${name}(?:\\[\\]|\\?)?(?=\\s|$)[^\\r\\n]*\\r?\\n`, 'gm'), '');
}

function replaceModel(name, body) {
  const pattern = new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, 'm');
  if (!pattern.test(schema)) throw new Error(`Model ${name} not found`);
  schema = schema.replace(pattern, body.trim());
}

if (!schema.includes('enum OrderType')) {
  const firstModel = schema.indexOf('model User {');
  schema = `${schema.slice(0, firstModel)}enum OrderType {\n  RETAIL_PICKUP\n  RETAIL_DELIVERY\n  B2B_TRANSPORT\n}\n\nenum PaymentTransactionType {\n  PAYMENT\n  REFUND\n}\n\nenum PackageEventType {\n  PACKED\n  HANDED_OVER\n  DEPARTED\n  ARRIVED_PICKUP_POINT\n  COLLECTED\n  DELIVERY_ATTEMPTED\n  RETURNED\n  CANCELLED\n}\n\n${schema.slice(firstModel)}`;
}

replaceModel('User', `
model User {
  id                   String                 @id @default(uuid())
  username             String                 @unique
  password             String
  fullName             String
  role                 Role                   @default(STAFF)
  phone                String?
  email                String?                @unique
  active               Boolean                @default(true)
  branchId             String?
  branch               Branch?                @relation(fields: [branchId], references: [id])
  locationId           String?
  location             Location?              @relation(fields: [locationId], references: [id])
  driver               Driver?
  employee             Employee?
  customer             Customer?
  roleScopes           UserRoleScope[]
  optimizationJobs     OptimizationJob[]
  orderEvents          OrderEvent[]           @relation("OrderEventActor")
  executionEvents      ExecutionEvent[]
  reportedIncidents    Incident[]             @relation("IncidentReporter")
  notifications        Notification[]
  processedCommands    ProcessedCommand[]
  auditLogs            AuditLog[]             @relation("AuditActor")
  issuedSalesInvoices  SalesInvoice[]         @relation("SalesInvoiceIssuer")
  assignedFeedback     FeedbackCase[]         @relation("FeedbackAssignee")
  feedbackMessages     FeedbackMessage[]
  packageEvents        PackageEvent[]
  verifiedTokens       CollectionToken[]
  createdLedgerEntries StockLedgerEntry[]
  createdReservations  InventoryReservation[]
  receivedStockReceipts StockReceipt[]
  createdStockAdjustments StockAdjustment[]
  createdPayrollRuns   PayrollRun[]           @relation("PayrollCreator")
  approvedPayrollRuns  PayrollRun[]           @relation("PayrollApprover")
  createdAt            DateTime               @default(now()) @db.Timestamptz(3)
  updatedAt            DateTime               @updatedAt @db.Timestamptz(3)
  @@map("users")
}`);

replaceModel('Branch', `
model Branch {
  id                            String            @id @default(uuid())
  code                          String            @unique
  name                          String
  address                       String
  latitude                      Float
  longitude                     Float
  phone                         String?
  timezone                      String            @default("Asia/Ho_Chi_Minh")
  workStartTime                 String            @default("08:00")
  workEndTime                   String            @default("17:00")
  fuelPricePerLiter             Decimal           @default(23000) @db.Decimal(12, 2)
  monthlyWorkingMinutes         Int               @default(10560)
  cargoHoldingCostVndPerTonHour Decimal           @default(0) @db.Decimal(14, 2)
  active                        Boolean           @default(true)
  users                         User[]
  vehicles                      Vehicle[]
  drivers                       Driver[]
  employees                     Employee[]
  orders                        Order[]
  roleScopes                    UserRoleScope[]
  optimizationJobs              OptimizationJob[]
  payrollPeriods                PayrollPeriod[]
  managedTrips                  Trip[]             @relation("ManagingBranch")
  managedLocations              Location[]         @relation("ManagingBranchLocations")
  createdAt                     DateTime           @default(now()) @db.Timestamptz(3)
  updatedAt                     DateTime           @updatedAt @db.Timestamptz(3)
  @@map("branches")
}`);

replaceModel('UserRoleScope', `
model UserRoleScope {
  id         String    @id @default(uuid())
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  role       Role
  scopeType  ScopeType
  branchId   String?
  branch     Branch?   @relation(fields: [branchId], references: [id], onDelete: Restrict)
  locationId String?
  location   Location? @relation(fields: [locationId], references: [id], onDelete: Restrict)
  active     Boolean   @default(true)
  createdAt  DateTime  @default(now()) @db.Timestamptz(3)
  updatedAt  DateTime  @updatedAt @db.Timestamptz(3)
  @@unique([userId, role, scopeType, branchId, locationId], map: "user_role_scopes_identity_key")
  @@index([branchId, active])
  @@index([locationId, active])
  @@map("user_location_scopes")
}`);

replaceModel('Location', `
model Location {
  id                         String                 @id @default(uuid())
  code                       String                 @unique
  name                       String
  type                       LocationType           @default(STORE)
  managingBranchId           String?
  managingBranch             Branch?                @relation("ManagingBranchLocations", fields: [managingBranchId], references: [id], onDelete: SetNull)
  address                    String
  ward                       String?
  district                   String?
  city                       String?
  latitude                   Float
  longitude                  Float
  timezone                   String                 @default("Asia/Ho_Chi_Minh")
  workStartTime              String                 @default("08:00")
  workEndTime                String                 @default("17:00")
  capabilities               Json?
  totalHoldingSlots          Int                    @default(0)
  availableHoldingSlots      Int                    @default(0)
  active                     Boolean                @default(true)
  userScopes                 UserRoleScope[]
  users                      User[]
  stockBalances              StockBalance[]
  ledgerEntries              StockLedgerEntry[]
  reservations               InventoryReservation[]
  stockReceipts              StockReceipt[]
  stockAdjustments           StockAdjustment[]
  pickupOrders               Order[]                @relation("PickupPointOrders")
  sourceOrders               Order[]                @relation("SourceOrders")
  sourceTransferShipments    TransferShipment[]     @relation("SourceTransferShipments")
  destTransferShipments      TransferShipment[]     @relation("DestTransferShipments")
  salesInvoices              SalesInvoice[]
  feedbackCases              FeedbackCase[]
  createdAt                  DateTime               @default(now()) @db.Timestamptz(3)
  updatedAt                  DateTime               @updatedAt @db.Timestamptz(3)
  @@index([type, active])
  @@index([managingBranchId])
  @@map("locations")
}`);

replaceModel('Product', `
model Product {
  id          String        @id @default(uuid())
  categoryId  String?
  category    Category?     @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  code        String        @unique
  name        String
  description String?
  brand       String?
  imageUrl    String?
  status      ProductStatus @default(DRAFT)
  skus        Sku[]
  createdAt   DateTime      @default(now()) @db.Timestamptz(3)
  updatedAt   DateTime      @updatedAt @db.Timestamptz(3)
  @@index([categoryId, status])
  @@map("products")
}`);

replaceModel('Sku', `
model Sku {
  id                  String                @id @default(uuid())
  productId           String
  product             Product               @relation(fields: [productId], references: [id], onDelete: Restrict)
  skuCode             String                @unique
  barcode             String?               @unique
  name                String
  uom                 String                @default("GOI")
  salePrice           Decimal               @default(0) @db.Decimal(20, 4)
  weightGrams         Int                   @default(0)
  lengthMm            Int                   @default(0)
  widthMm             Int                   @default(0)
  heightMm            Int                   @default(0)
  volumeMm3           BigInt                @default(0)
  storageCondition    StorageCondition      @default(AMBIENT)
  isSellable          Boolean               @default(true)
  allowPickup         Boolean               @default(true)
  status              SkuStatus             @default(ACTIVE)
  stockBalances       StockBalance[]
  ledgerEntries       StockLedgerEntry[]
  reservations        InventoryReservation[]
  receiptLines        StockReceiptLine[]
  adjustmentLines     StockAdjustmentLine[]
  orderItems          OrderItem[]
  createdAt           DateTime              @default(now()) @db.Timestamptz(3)
  updatedAt           DateTime              @updatedAt @db.Timestamptz(3)
  @@index([productId, status])
  @@index([storageCondition, isSellable])
  @@map("skus")
}`);

replaceModel('Customer', `
model Customer {
  id            String            @id @default(uuid())
  code          String            @unique
  userId        String?           @unique
  user          User?             @relation(fields: [userId], references: [id], onDelete: SetNull)
  name          String
  taxCode       String?
  address       String?
  contactPerson String?
  phone         String            @unique
  email         String?
  orders        Order[]
  addresses     CustomerAddress[]
  feedbackCases FeedbackCase[]
  feedbackMessages FeedbackMessage[]
  createdAt     DateTime          @default(now()) @db.Timestamptz(3)
  updatedAt     DateTime          @updatedAt @db.Timestamptz(3)
  @@map("customers")
}`);

replaceModel('Order', `
model Order {
  id                    String            @id @default(uuid())
  orderNumber           String            @unique
  orderType             OrderType         @default(B2B_TRANSPORT)
  customerId            String
  customer              Customer          @relation(fields: [customerId], references: [id], onDelete: Restrict)
  branchId              String
  branch                Branch            @relation(fields: [branchId], references: [id], onDelete: Restrict)
  selectedPickupPointId String?
  selectedPickupPoint   Location?         @relation("PickupPointOrders", fields: [selectedPickupPointId], references: [id], onDelete: Restrict)
  allocatedSourceId     String?
  allocatedSource       Location?         @relation("SourceOrders", fields: [allocatedSourceId], references: [id], onDelete: SetNull)
  status                OrderStatus       @default(CONFIRMED)
  paymentStatus         PaymentStatus     @default(PENDING)
  paymentMethod         String            @default("MANUAL_PENDING")
  subtotal              Decimal           @default(0) @db.Decimal(20, 4)
  discountAmount        Decimal           @default(0) @db.Decimal(20, 4)
  shippingFee           Decimal           @default(0) @db.Decimal(20, 4)
  totalAmount           Decimal           @default(0) @db.Decimal(20, 4)
  currency              String            @default("VND")
  totalWeightKg         Float             @default(0)
  totalVolumeM3         Float             @default(0)
  totalPackages         Int               @default(0)
  version               Int               @default(1)
  notes                 String?
  stops                 OrderStop[]
  items                 OrderItem[]
  events                OrderEvent[]
  packages              Package[]
  reservations          InventoryReservation[]
  payments              PaymentTransaction[]
  invoice               SalesInvoice?
  collectionToken       CollectionToken?
  feedbackCases         FeedbackCase[]
  incidentLinks         IncidentOrder[]
  createdAt             DateTime          @default(now()) @db.Timestamptz(3)
  updatedAt             DateTime          @updatedAt @db.Timestamptz(3)
  @@index([branchId, status])
  @@index([selectedPickupPointId, status])
  @@map("orders")
}`);

replaceModel('OrderItem', `
model OrderItem {
  id          String        @id @default(uuid())
  orderId     String
  order       Order         @relation(fields: [orderId], references: [id], onDelete: Cascade)
  skuId       String?
  skuRef      Sku?          @relation(fields: [skuId], references: [id], onDelete: Restrict)
  sku         String?
  description String
  packageType String        @default("CARTON")
  quantity    Int
  unitPrice   Decimal       @default(0) @db.Decimal(20, 4)
  lineTotal   Decimal       @default(0) @db.Decimal(20, 4)
  weightKg    Float
  lengthCm    Float
  widthCm     Float
  heightCm    Float
  volumeM3    Float
  packageItems PackageItem[]
  invoiceLines SalesInvoiceLine[]
  createdAt   DateTime      @default(now()) @db.Timestamptz(3)
  @@index([orderId])
  @@index([skuId])
  @@map("order_items")
}`);

replaceModel('OrderEvent', `
model OrderEvent {
  id          String   @id @default(uuid())
  orderId     String
  order       Order    @relation(fields: [orderId], references: [id], onDelete: Restrict)
  eventType   String
  fromStatus  String?
  toStatus    String?
  actorUserId String?
  actorUser   User?    @relation("OrderEventActor", fields: [actorUserId], references: [id], onDelete: SetNull)
  commandId   String?  @unique
  payload     Json?
  occurredAt  DateTime @default(now()) @db.Timestamptz(3)
  @@index([orderId, occurredAt])
  @@map("order_status_events")
}`);

replaceModel('CollectionToken', `
model CollectionToken {
  id           String    @id @default(uuid())
  orderId      String    @unique
  order        Order     @relation(fields: [orderId], references: [id], onDelete: Restrict)
  otpCode      String
  qrToken      String    @unique
  status       String    @default("ACTIVE")
  expiresAt    DateTime  @db.Timestamptz(3)
  attemptCount Int       @default(0)
  verifiedAt   DateTime? @db.Timestamptz(3)
  verifiedById String?
  verifiedBy   User?     @relation(fields: [verifiedById], references: [id], onDelete: SetNull)
  createdAt    DateTime  @default(now()) @db.Timestamptz(3)
  @@map("collection_tokens")
}`);

replaceModel('Package', `
model Package {
  id                       String                 @id @default(uuid())
  orderId                  String
  order                    Order                  @relation(fields: [orderId], references: [id], onDelete: Restrict)
  packageCode              String                 @unique
  lengthMm                 Int
  widthMm                  Int
  heightMm                 Int
  weightG                  BigInt
  allowedOrientations      Json
  measurementSource        String
  measuredAt               DateTime?              @db.Timestamptz(3)
  status                   PackageStatus          @default(DRAFT)
  holdingSlot              String?
  arrivedAtPickupPointAt   DateTime?              @db.Timestamptz(3)
  releasedAt               DateTime?              @db.Timestamptz(3)
  version                  Int                    @default(1)
  items                    PackageItem[]
  events                   PackageEvent[]
  transferShipment         TransferShipment?
  loadPlanSteps            LoadPlanStep[]
  loadPlacements           LoadPlacement[]
  feedbackCases            FeedbackCase[]
  createdAt                DateTime               @default(now()) @db.Timestamptz(3)
  updatedAt                DateTime               @updatedAt @db.Timestamptz(3)
  @@index([orderId, status])
  @@map("packages")
}`);

replaceModel('TransferShipment', `
model TransferShipment {
  id                            String                 @id @default(uuid())
  shipmentNumber                String                 @unique
  packageId                     String                 @unique
  package                       Package                @relation(fields: [packageId], references: [id], onDelete: Restrict)
  sourceLocationId              String
  sourceLocation                Location               @relation("SourceTransferShipments", fields: [sourceLocationId], references: [id], onDelete: Restrict)
  destinationPickupPointId      String
  destinationPickupPoint        Location               @relation("DestTransferShipments", fields: [destinationPickupPointId], references: [id], onDelete: Restrict)
  tripAssignments               TripTransferShipment[]
  status                        String                 @default("CREATED")
  transferFee                   Decimal                @default(0) @db.Decimal(14, 2)
  promisedCollectionWindowStart DateTime?              @db.Timestamptz(3)
  promisedCollectionWindowEnd   DateTime?              @db.Timestamptz(3)
  shippedAt                     DateTime?              @db.Timestamptz(3)
  receivedAt                    DateTime?              @db.Timestamptz(3)
  createdAt                     DateTime               @default(now()) @db.Timestamptz(3)
  updatedAt                     DateTime               @updatedAt @db.Timestamptz(3)
  @@index([sourceLocationId])
  @@index([destinationPickupPointId, status])
  @@map("transfer_shipments")
}`);

replaceModel('Employee', `
model Employee {
  id               String           @id @default(uuid())
  employeeCode     String           @unique
  userId           String?          @unique
  user             User?            @relation(fields: [userId], references: [id], onDelete: Restrict)
  branchId         String
  branch           Branch           @relation(fields: [branchId], references: [id], onDelete: Restrict)
  departmentName   String?
  positionName     String?
  baseSalary       Decimal          @default(0) @db.Decimal(20, 4)
  fullName         String
  phone            String?
  email            String?
  citizenId        String?          @unique
  joinedOn         DateTime         @db.Date
  leftOn           DateTime?        @db.Date
  employmentStatus EmploymentStatus @default(ACTIVE)
  version          Int              @default(1)
  driverProfile    Driver?
  attendance       AttendanceEntry[]
  leaveRecords     EmployeeLeave[]
  payrollItems     PayrollItem[]
  createdAt        DateTime         @default(now()) @db.Timestamptz(3)
  updatedAt        DateTime         @updatedAt @db.Timestamptz(3)
  @@index([branchId, employmentStatus])
  @@map("employees")
}`);

replaceModel('DriverAssignment', `
model DriverAssignment {
  id          String    @id @default(uuid())
  tripId      String
  trip        Trip      @relation(fields: [tripId], references: [id], onDelete: Cascade)
  driverId    String
  driver      Driver    @relation(fields: [driverId], references: [id])
  startStopId String?
  startStop   TripStop? @relation("AssignmentStartStop", fields: [startStopId], references: [id], onDelete: Restrict)
  endStopId   String?
  endStop     TripStop? @relation("AssignmentEndStop", fields: [endStopId], references: [id], onDelete: Restrict)
  startTime   DateTime  @db.Timestamptz(3)
  endTime     DateTime  @db.Timestamptz(3)
  role        String    @default("PRIMARY")
  status      String    @default("ASSIGNED")
  createdAt   DateTime  @default(now()) @db.Timestamptz(3)
  @@index([driverId, startTime, endTime])
  @@index([tripId, status])
  @@map("driver_assignments")
}`);

replaceModel('StopTask', `
model StopTask {
  id              String           @id @default(uuid())
  tripStopId      String
  tripStop        TripStop         @relation(fields: [tripStopId], references: [id], onDelete: Cascade)
  orderId         String?
  order           Order?           @relation(fields: [orderId], references: [id], onDelete: Restrict)
  packageId       String?
  package         Package?         @relation(fields: [packageId], references: [id], onDelete: Restrict)
  orderStopId     String?
  orderStop       OrderStop?       @relation(fields: [orderStopId], references: [id], onDelete: Restrict)
  action          TaskAction
  plannedQuantity Int
  actualQuantity  Int?
  notes           String?
  executionEvents ExecutionEvent[]
  loadPlanSteps   LoadPlanStep[]
  createdAt       DateTime         @default(now()) @db.Timestamptz(3)
  @@index([tripStopId, action])
  @@index([orderId])
  @@index([packageId])
  @@map("stop_tasks")
}`);

replaceModel('ResourceReservation', `
model ResourceReservation {
  id        String            @id @default(uuid())
  tripId    String
  trip      Trip              @relation(fields: [tripId], references: [id], onDelete: Restrict)
  vehicleId String?
  vehicle   Vehicle?          @relation(fields: [vehicleId], references: [id], onDelete: Restrict)
  driverId  String?
  driver    Driver?           @relation(fields: [driverId], references: [id], onDelete: Restrict)
  startsAt  DateTime          @db.Timestamptz(3)
  endsAt    DateTime          @db.Timestamptz(3)
  status    ReservationStatus @default(HELD)
  createdAt DateTime          @default(now()) @db.Timestamptz(3)
  updatedAt DateTime          @updatedAt @db.Timestamptz(3)
  @@index([tripId, status])
  @@index([vehicleId, startsAt, endsAt])
  @@index([driverId, startsAt, endsAt])
  @@map("resource_reservations")
}`);

replaceModel('LoadPlan', `
model LoadPlan {
  id                   String               @id @default(uuid())
  tripId               String
  trip                 Trip                 @relation(fields: [tripId], references: [id], onDelete: Restrict)
  revision             Int
  initialStateSnapshot Json
  geometrySnapshot     Json
  validationStatus     LoadValidationStatus @default(PENDING)
  validatorVersion     String
  inputHash            String
  steps                LoadPlanStep[]
  createdAt            DateTime             @default(now()) @db.Timestamptz(3)
  @@unique([tripId, revision])
  @@index([validationStatus, createdAt])
  @@map("load_plans")
}`);

replaceModel('LoadPlanStep', `
model LoadPlanStep {
  id               String          @id @default(uuid())
  loadPlanId       String
  loadPlan         LoadPlan        @relation(fields: [loadPlanId], references: [id], onDelete: Cascade)
  stepNumber       Int
  stopTaskId       String?
  stopTask         StopTask?       @relation(fields: [stopTaskId], references: [id], onDelete: Restrict)
  operationType    String
  packageId        String?
  package          Package?        @relation(fields: [packageId], references: [id], onDelete: Restrict)
  handlingPath     Json?
  validationResult Json
  placements       LoadPlacement[]
  createdAt        DateTime        @default(now()) @db.Timestamptz(3)
  @@unique([loadPlanId, stepNumber])
  @@index([stopTaskId])
  @@map("load_plan_steps")
}`);

replaceModel('ExecutionEvent', `
model ExecutionEvent {
  id           String    @id @default(uuid())
  tripId       String
  trip         Trip      @relation(fields: [tripId], references: [id], onDelete: Restrict)
  tripStopId   String?
  tripStop     TripStop? @relation(fields: [tripStopId], references: [id], onDelete: Restrict)
  stopTaskId   String?
  stopTask     StopTask? @relation(fields: [stopTaskId], references: [id], onDelete: Restrict)
  eventType    String
  occurredAt   DateTime  @db.Timestamptz(3)
  receivedAt   DateTime  @default(now()) @db.Timestamptz(3)
  actorUserId  String
  actorUser    User      @relation(fields: [actorUserId], references: [id], onDelete: Restrict)
  commandId    String    @unique
  payload      Json?
  @@index([tripId, occurredAt])
  @@index([tripStopId, occurredAt])
  @@map("execution_events")
}`);

replaceModel('SalesInvoice', `
model SalesInvoice {
  id            String             @id @default(uuid())
  invoiceNumber String             @unique
  orderId       String             @unique
  order         Order              @relation(fields: [orderId], references: [id], onDelete: Restrict)
  locationId    String
  location      Location           @relation(fields: [locationId], references: [id], onDelete: Restrict)
  status        InvoiceStatus      @default(DRAFT)
  buyerName     String
  buyerPhone    String?
  buyerTaxCode  String?
  buyerAddress  String?
  subtotal      Decimal            @db.Decimal(20, 4)
  taxAmount     Decimal            @default(0) @db.Decimal(20, 4)
  totalAmount   Decimal            @db.Decimal(20, 4)
  currency      String             @default("VND")
  providerRef   String?            @unique
  issuedAt      DateTime?          @db.Timestamptz(3)
  voidedAt      DateTime?          @db.Timestamptz(3)
  issuedById    String?
  issuedBy      User?              @relation("SalesInvoiceIssuer", fields: [issuedById], references: [id], onDelete: SetNull)
  lines         SalesInvoiceLine[]
  createdAt     DateTime           @default(now()) @db.Timestamptz(3)
  updatedAt     DateTime           @updatedAt @db.Timestamptz(3)
  @@index([locationId, status, issuedAt])
  @@map("sales_invoices")
}`);

replaceModel('SalesInvoiceLine', `
model SalesInvoiceLine {
  id             String       @id @default(uuid())
  salesInvoiceId String
  salesInvoice   SalesInvoice @relation(fields: [salesInvoiceId], references: [id], onDelete: Cascade)
  orderItemId    String?
  orderItem      OrderItem?   @relation(fields: [orderItemId], references: [id], onDelete: Restrict)
  skuCode        String
  skuName        String
  uom            String
  quantity       Int
  unitPrice      Decimal      @db.Decimal(20, 4)
  taxRate        Decimal      @default(0) @db.Decimal(5, 2)
  taxAmount      Decimal      @default(0) @db.Decimal(20, 4)
  lineTotal      Decimal      @db.Decimal(20, 4)
  createdAt      DateTime     @default(now()) @db.Timestamptz(3)
  @@index([salesInvoiceId])
  @@index([orderItemId])
  @@map("sales_invoice_lines")
}`);

replaceModel('FeedbackCase', `
model FeedbackCase {
  id               String           @id @default(uuid())
  caseNumber       String           @unique
  type             FeedbackType
  status           FeedbackStatus   @default(OPEN)
  priority         FeedbackPriority @default(NORMAL)
  customerId       String
  customer         Customer         @relation(fields: [customerId], references: [id], onDelete: Restrict)
  orderId          String?
  order            Order?           @relation(fields: [orderId], references: [id], onDelete: Restrict)
  packageId        String?
  package          Package?         @relation(fields: [packageId], references: [id], onDelete: Restrict)
  locationId       String?
  location         Location?        @relation(fields: [locationId], references: [id], onDelete: Restrict)
  assignedToUserId String?
  assignedToUser   User?            @relation("FeedbackAssignee", fields: [assignedToUserId], references: [id], onDelete: SetNull)
  subject          String
  description      String
  rating           Int?
  resolution       String?
  resolvedAt       DateTime?        @db.Timestamptz(3)
  version          Int              @default(1)
  messages         FeedbackMessage[]
  createdAt        DateTime         @default(now()) @db.Timestamptz(3)
  updatedAt        DateTime         @updatedAt @db.Timestamptz(3)
  @@index([customerId, status, createdAt])
  @@index([assignedToUserId, status, priority])
  @@index([locationId, status])
  @@map("feedback_cases")
}`);

replaceModel('FeedbackMessage', `
model FeedbackMessage {
  id             String       @id @default(uuid())
  feedbackCaseId String
  feedbackCase   FeedbackCase @relation(fields: [feedbackCaseId], references: [id], onDelete: Cascade)
  authorUserId   String?
  authorUser     User?        @relation(fields: [authorUserId], references: [id], onDelete: SetNull)
  authorCustomerId String?
  authorCustomer Customer?    @relation(fields: [authorCustomerId], references: [id], onDelete: SetNull)
  message        String
  visibility     String       @default("PUBLIC")
  createdAt      DateTime     @default(now()) @db.Timestamptz(3)
  @@index([feedbackCaseId, createdAt])
  @@map("feedback_messages")
}`);

// Append the three intentionally consolidated models.
schema += `

model PaymentTransaction {
  id             String                 @id @default(uuid())
  orderId        String
  order          Order                  @relation(fields: [orderId], references: [id], onDelete: Restrict)
  type           PaymentTransactionType
  amount         Decimal                @db.Decimal(20, 4)
  method         String
  status         PaymentStatus          @default(PENDING)
  transactionRef String?                @unique
  idempotencyKey String                 @unique
  actorUserId    String?
  occurredAt     DateTime               @default(now()) @db.Timestamptz(3)
  metadata       Json?
  createdAt      DateTime               @default(now()) @db.Timestamptz(3)
  @@index([orderId, type, createdAt])
  @@map("payment_transactions")
}

model PackageItem {
  id          String    @id @default(uuid())
  packageId   String
  package     Package   @relation(fields: [packageId], references: [id], onDelete: Cascade)
  orderItemId String
  orderItem   OrderItem @relation(fields: [orderItemId], references: [id], onDelete: Restrict)
  quantity    Int
  createdAt   DateTime  @default(now()) @db.Timestamptz(3)
  @@unique([packageId, orderItemId])
  @@index([orderItemId])
  @@map("package_items")
}

model PackageEvent {
  id          String           @id @default(uuid())
  packageId   String
  package     Package          @relation(fields: [packageId], references: [id], onDelete: Restrict)
  eventType   PackageEventType
  locationId  String?
  actorUserId String?
  actorUser   User?            @relation(fields: [actorUserId], references: [id], onDelete: SetNull)
  notes       String?
  metadata    Json?
  occurredAt  DateTime         @default(now()) @db.Timestamptz(3)
  @@index([packageId, occurredAt])
  @@map("package_events")
}
`;

fs.writeFileSync(schemaPath, schema);
console.log(`Simplified Prisma schema: ${existingModels.length} -> ${keep.size + 3} models`);
