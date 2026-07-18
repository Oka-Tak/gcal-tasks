CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`amount_yen` integer NOT NULL,
	`category` text DEFAULT 'sub' NOT NULL,
	`billing_day` integer DEFAULT 1 NOT NULL,
	`note` text,
	`active` integer DEFAULT 1 NOT NULL,
	`start_ms` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `subscriptions_active` ON `subscriptions` (`active`);--> statement-breakpoint
ALTER TABLE `expenses` ADD `kind` text DEFAULT 'spot';--> statement-breakpoint
ALTER TABLE `expenses` ADD `subscription_id` text;