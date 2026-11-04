// Dev-only showcase data for the FE design review (dev DB is disposable).
// Idempotent: Spanish role descriptions for Sucursal Centro, a readable driver
// name, and the active delivery route restarted "a few minutes ago".
// Run: node --env-file=.env scripts/dev-showcase/roles-and-route.cjs
const { PrismaClient } = require('@prisma/client');

const ROLE_DESCRIPTIONS = {
  Manager: 'Gerente: acceso completo a la sucursal',
  Cashier: 'Cajero: ventas, cobros y caja',
  repartidor: 'Repartidor: rutas y entregas asignadas',
};
const DRIVER_EMAIL = 'repartidor@houndfe.com';
const DRIVER_NAME = 'Luis Hernández';
const STARTED_MINUTES_AGO = 25;

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { slug: 'centro' },
  });

  for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS)) {
    const { count } = await prisma.role.updateMany({
      where: { tenantId: tenant.id, name },
      data: { description },
    });
    console.log(`role ${name}: ${count ? description : 'not found'}`);
  }

  const driver = await prisma.user.update({
    where: { email: DRIVER_EMAIL },
    data: { name: DRIVER_NAME },
  });
  console.log(`driver: ${driver.name}`);

  const route = await prisma.deliveryRoute.findFirst({
    where: { tenantId: tenant.id, status: 'ACTIVE', driverUserId: driver.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!route) {
    console.log('no active route for the driver; nothing to restart');
    return;
  }
  const startedAt = new Date(Date.now() - STARTED_MINUTES_AGO * 60_000);
  await prisma.deliveryRoute.update({
    where: { id: route.id },
    data: { startedAt },
  });
  console.log(`active route started at ${startedAt.toISOString()}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
