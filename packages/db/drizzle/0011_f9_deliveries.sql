CREATE TYPE "public"."delivery_channel" AS ENUM('whatsapp', 'email');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('queued', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"session_id" text NOT NULL,
	"channel" "delivery_channel" NOT NULL,
	"recipient_encrypted" text NOT NULL,
	"recipient_hint" text NOT NULL,
	"status" "delivery_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"provider_message_id" text,
	"requested_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deliveries_session_idx" ON "deliveries" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "deliveries_status_idx" ON "deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- Studio reads delivery status of its own org (masked recipient only; the encrypted column is
-- useless without the API/worker key). Writes go through the API/worker (service role).
ALTER TABLE "deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "deliveries_member_read" ON "deliveries" FOR SELECT TO authenticated USING (app.is_org_member(org_id));
--> statement-breakpoint
GRANT SELECT ON "deliveries" TO authenticated;
