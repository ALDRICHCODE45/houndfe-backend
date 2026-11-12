-- Unit 11, T11c (S15 Q5, S16 9): staff media in a live conversation.
-- A file the attendee uploads belongs to ONE request and ONE staff user, so a
-- message can only carry media its sender uploaded for that very request (a
-- mediaId of another tenant, request or user is a 404). `filename` is the
-- sanitized name the bot shows the customer (never a storage key). All three
-- are NULL for the bot's customer uploads (unit 9).
ALTER TABLE "conversation_media"
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "uploadedByUserId" TEXT,
  ADD COLUMN "filename" VARCHAR(120);

ALTER TABLE "conversation_media"
  ADD CONSTRAINT "conversation_media_staff_owner_chk"
  CHECK (("requestId" IS NULL) = ("uploadedByUserId" IS NULL));
