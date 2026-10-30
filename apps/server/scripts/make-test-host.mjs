import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const hash = await bcrypt.hash('Host@12345', 10);
const user = await prisma.user.upsert({
  where: { email: 'host2@webinar.local' },
  update: { passwordHash: hash, role: 'HOST' },
  create: {
    name: 'Second Host',
    email: 'host2@webinar.local',
    role: 'HOST',
    passwordHash: hash,
  },
});
console.log('created', user.id, user.email, user.role);
await prisma.$disconnect();
