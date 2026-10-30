import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL ?? 'admin@webinar.local').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'Admin@12345';

  const passwordHash = await bcrypt.hash(adminPassword, 10);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: { passwordHash, role: 'ADMIN' },
    create: {
      name: 'Platform Admin',
      email: adminEmail,
      role: 'ADMIN',
      passwordHash,
    },
  });
  console.log(`✔ Admin ready: ${admin.email} / ${adminPassword}`);

  const host = await prisma.user.upsert({
    where: { email: 'host@webinar.local' },
    update: {},
    create: {
      name: 'Ananya Sharma',
      email: 'host@webinar.local',
      role: 'HOST',
      passwordHash: await bcrypt.hash('Host@12345', 10),
    },
  });

  const moderator = await prisma.user.upsert({
    where: { email: 'mod@webinar.local' },
    update: {},
    create: {
      name: 'Rohit Verma',
      email: 'mod@webinar.local',
      role: 'MODERATOR',
      passwordHash: await bcrypt.hash('Mod@12345', 10),
    },
  });

  const course = await prisma.course.upsert({
    where: { id: 'course-fullstack-mastery' },
    update: {},
    create: {
      id: 'course-fullstack-mastery',
      title: 'Full-Stack Product Engineering',
      description:
        'A 12-week cohort program covering TypeScript, React, Node, PostgreSQL and system design — with weekly live reviews.',
      pricePaise: 499900,
      currency: 'INR',
    },
  });

  const existing = await prisma.webinar.findUnique({ where: { slug: 'live-product-teardown' } });

  if (!existing) {
    const startsAt = new Date(Date.now() + 1000 * 60 * 60 * 26); // ~26h from now

    const webinar = await prisma.webinar.create({
      data: {
        slug: 'live-product-teardown',
        title: 'Live Product Teardown: Building a Real-Time Webinar Platform',
        description:
          'Join us for a deep dive into the architecture behind a production webinar platform — mediasoup SFU routing, role-based media visibility, Razorpay payments and real-time engagement. We will tear down the code live and answer your questions.',
        bannerUrl:
          'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1600&q=80',
        startsAt,
        durationMins: 90,
        timezone: 'Asia/Kolkata',
        status: 'SCHEDULED',
        allowMic: true,
        allowVideo: true,
        requireRegistration: true,
        requirePayment: false,
        priceInPaise: 0,
        chatEnabled: true,
        handRaiseEnabled: true,
        maxParticipants: 500,
        hostId: host.id,
        createdById: admin.id,
        moderators: { create: [{ userId: moderator.id }] },
      },
    });
    console.log(`✔ Webinar seeded: /w/${webinar.slug}`);

    await prisma.quiz.createMany({
      data: [
        {
          webinarId: webinar.id,
          question: 'Which component decides whether a participant may receive a stream?',
          optionsJson: JSON.stringify([
            { id: 'a', text: 'The React component tree' },
            { id: 'b', text: 'The SFU visibility policy on the server' },
            { id: 'c', text: 'The browser media permissions' },
            { id: 'd', text: 'The CDN edge config' },
          ]),
          correctOptionId: 'b',
          timeLimitSecs: 30,
        },
        {
          webinarId: webinar.id,
          question: 'What does mediasoup use to route media between peers?',
          optionsJson: JSON.stringify([
            { id: 'a', text: 'A mesh of peer connections' },
            { id: 'b', text: 'A selective forwarding unit (SFU)' },
            { id: 'c', text: 'An RTMP relay' },
            { id: 'd', text: 'HLS segments' },
          ]),
          correctOptionId: 'b',
          timeLimitSecs: 25,
        },
      ],
    });

    await prisma.poll.createMany({
      data: [
        {
          webinarId: webinar.id,
          question: 'How are you watching today?',
          optionsJson: JSON.stringify([
            { id: 'a', text: 'Desktop / laptop' },
            { id: 'b', text: 'Phone' },
            { id: 'c', text: 'Tablet' },
            { id: 'd', text: 'Cast to a TV' },
          ]),
          // 0 = stays open until the host closes it.
          timeLimitSecs: 0,
        },
        {
          webinarId: webinar.id,
          question: 'Which topic should we go deeper on?',
          optionsJson: JSON.stringify([
            { id: 'a', text: 'SFU scaling and simulcast' },
            { id: 'b', text: 'Payments and checkout flows' },
            { id: 'c', text: 'Realtime engagement features' },
          ]),
          timeLimitSecs: 60,
        },
      ],
    });

    await prisma.cta.create({
      data: {
        webinarId: webinar.id,
        courseId: course.id,
        title: 'Enroll in Full-Stack Product Engineering',
        description:
          'Loved this session? Join the 12-week cohort and build production systems with expert reviews every week.',
        buttonText: 'Enroll Now',
      },
    });
    console.log('✔ Quizzes, polls and CTA seeded');
  } else {
    console.log('• Demo webinar already exists, skipping');
  }

  // A paid webinar example
  const paidSlug = 'advanced-sfu-masterclass';
  const paidExisting = await prisma.webinar.findUnique({ where: { slug: paidSlug } });
  if (!paidExisting) {
    await prisma.webinar.create({
      data: {
        slug: paidSlug,
        title: 'Advanced SFU Masterclass — Scaling to 10,000 Viewers',
        description:
          'A premium 2-hour masterclass on scaling mediasoup deployments: worker pools, simulcast tuning, HLS fallback and cost optimisation.',
        bannerUrl:
          'https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&w=1600&q=80',
        startsAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 5),
        durationMins: 120,
        status: 'SCHEDULED',
        allowMic: false,
        allowVideo: false,
        requireRegistration: true,
        requirePayment: true,
        priceInPaise: 99900,
        chatEnabled: true,
        handRaiseEnabled: true,
        maxParticipants: 200,
        hostId: host.id,
        createdById: admin.id,
        moderators: { create: [{ userId: moderator.id }] },
      },
    });
    console.log(`✔ Paid webinar seeded: /w/${paidSlug}`);
  }

  console.log('\n🎉 Seed complete\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
