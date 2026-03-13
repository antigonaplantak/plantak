-- booking -> outbox transactional wiring
-- safe re-runnable migration body

DROP TRIGGER IF EXISTS booking_outbox_insert_trigger ON "Booking";
DROP TRIGGER IF EXISTS booking_outbox_update_trigger ON "Booking";
DROP FUNCTION IF EXISTS public.enqueue_booking_outbox_event();

CREATE OR REPLACE FUNCTION public.enqueue_booking_outbox_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_id text;
BEGIN
  v_id := md5(random()::text || clock_timestamp()::text)
       || md5(random()::text || clock_timestamp()::text);

  IF TG_OP = 'INSERT' THEN
    INSERT INTO "OutboxEvent" (
      id,
      "businessId",
      "aggregateType",
      "aggregateId",
      "eventType",
      payload,
      status,
      attempts,
      "availableAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      v_id,
      NEW."businessId",
      'booking',
      NEW.id,
      'booking.created',
      jsonb_build_object(
        'bookingId', NEW.id,
        'businessId', NEW."businessId",
        'staffId', NEW."staffId",
        'serviceId', NEW."serviceId",
        'customerId', NEW."customerId",
        'locationId', NEW."locationId",
        'status', NEW.status::text,
        'startAt', NEW."startAt",
        'endAt', NEW."endAt",
        'source', 'db_trigger'
      ),
      'PENDING'::"OutboxStatus",
      0,
      NOW(),
      NOW(),
      NOW()
    );

    RETURN NEW;
  END IF;

  IF NEW."startAt" IS DISTINCT FROM OLD."startAt"
     OR NEW."endAt" IS DISTINCT FROM OLD."endAt" THEN
    INSERT INTO "OutboxEvent" (
      id,
      "businessId",
      "aggregateType",
      "aggregateId",
      "eventType",
      payload,
      status,
      attempts,
      "availableAt",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      md5(random()::text || clock_timestamp()::text)
      || md5(random()::text || clock_timestamp()::text),
      NEW."businessId",
      'booking',
      NEW.id,
      'booking.rescheduled',
      jsonb_build_object(
        'bookingId', NEW.id,
        'businessId', NEW."businessId",
        'staffId', NEW."staffId",
        'serviceId', NEW."serviceId",
        'customerId', NEW."customerId",
        'locationId', NEW."locationId",
        'status', NEW.status::text,
        'oldStartAt', OLD."startAt",
        'newStartAt', NEW."startAt",
        'oldEndAt', OLD."endAt",
        'newEndAt', NEW."endAt",
        'source', 'db_trigger'
      ),
      'PENDING'::"OutboxStatus",
      0,
      NOW(),
      NOW(),
      NOW()
    );
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status::text = 'CONFIRMED' THEN
      INSERT INTO "OutboxEvent" (
        id,
        "businessId",
        "aggregateType",
        "aggregateId",
        "eventType",
        payload,
        status,
        attempts,
        "availableAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        md5(random()::text || clock_timestamp()::text)
        || md5(random()::text || clock_timestamp()::text),
        NEW."businessId",
        'booking',
        NEW.id,
        'booking.confirmed',
        jsonb_build_object(
          'bookingId', NEW.id,
          'businessId', NEW."businessId",
          'staffId', NEW."staffId",
          'serviceId', NEW."serviceId",
          'customerId', NEW."customerId",
          'locationId', NEW."locationId",
          'previousStatus', OLD.status::text,
          'status', NEW.status::text,
          'startAt', NEW."startAt",
          'endAt', NEW."endAt",
          'source', 'db_trigger'
        ),
        'PENDING'::"OutboxStatus",
        0,
        NOW(),
        NOW(),
        NOW()
      );
    ELSIF NEW.status::text = 'CANCELLED' THEN
      INSERT INTO "OutboxEvent" (
        id,
        "businessId",
        "aggregateType",
        "aggregateId",
        "eventType",
        payload,
        status,
        attempts,
        "availableAt",
        "createdAt",
        "updatedAt"
      )
      VALUES (
        md5(random()::text || clock_timestamp()::text)
        || md5(random()::text || clock_timestamp()::text),
        NEW."businessId",
        'booking',
        NEW.id,
        'booking.cancelled',
        jsonb_build_object(
          'bookingId', NEW.id,
          'businessId', NEW."businessId",
          'staffId', NEW."staffId",
          'serviceId', NEW."serviceId",
          'customerId', NEW."customerId",
          'locationId', NEW."locationId",
          'previousStatus', OLD.status::text,
          'status', NEW.status::text,
          'startAt', NEW."startAt",
          'endAt', NEW."endAt",
          'source', 'db_trigger'
        ),
        'PENDING'::"OutboxStatus",
        0,
        NOW(),
        NOW(),
        NOW()
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER booking_outbox_insert_trigger
AFTER INSERT ON "Booking"
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_booking_outbox_event();

CREATE TRIGGER booking_outbox_update_trigger
AFTER UPDATE OF status, "startAt", "endAt" ON "Booking"
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_booking_outbox_event();
