import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { initSentry } from './common/sentry/sentry.init';

type ReqWithId = Request & { id?: string };

function requestIdMiddleware(
  req: ReqWithId,
  res: Response,
  next: NextFunction,
) {
  const hdr = req.headers['x-request-id'];
  const rid =
    typeof hdr === 'string' && hdr.length > 0 ? hdr : crypto.randomUUID();
  req.id = rid;
  res.setHeader('x-request-id', rid);
  next();
}

async function bootstrap() {
  initSentry();

  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));


  app.use(requestIdMiddleware);
  app.use(
    helmet({
      contentSecurityPolicy: true,
    }),
  );

  app.setGlobalPrefix('api');

  const enableSwagger =
    process.env.ENABLE_SWAGGER === 'true' ||
    (process.env.ENABLE_SWAGGER !== 'false' &&
      process.env.NODE_ENV !== 'production');

  if (enableSwagger) {
    const config = new DocumentBuilder()
      .setTitle('Plantak API')
      .setDescription('Plantak Booking API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document, { useGlobalPrefix: true });
  }

  await app.listen(
    process.env.PORT ? Number(process.env.PORT) : 3001,
    '0.0.0.0',
  );
}

void bootstrap();
