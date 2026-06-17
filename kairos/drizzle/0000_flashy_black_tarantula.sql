CREATE TABLE `accounts` (
	`email` text PRIMARY KEY NOT NULL,
	`name` text,
	`picture` text,
	`color` text,
	`access_token` text,
	`refresh_token` text,
	`expires_at` integer,
	`scope` text,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `calendars` (
	`account` text NOT NULL,
	`google_id` text NOT NULL,
	`summary` text,
	`color` text,
	`primary` integer,
	`access_role` text,
	`selected` integer,
	`synced_at` integer,
	`deleted_at` integer,
	PRIMARY KEY(`account`, `google_id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`account` text NOT NULL,
	`calendar_id` text NOT NULL,
	`google_id` text NOT NULL,
	`summary` text,
	`description` text,
	`location` text,
	`start` text,
	`end` text,
	`all_day` integer,
	`start_ms` integer,
	`end_ms` integer,
	`status` text,
	`color` text,
	`attendees` text,
	`meet` text,
	`attachments` text,
	`html_link` text,
	`organizer` text,
	`recurring` integer,
	`google_updated` text,
	`synced_at` integer,
	`deleted_at` integer,
	PRIMARY KEY(`account`, `calendar_id`, `google_id`)
);
--> statement-breakpoint
CREATE INDEX `events_range` ON `events` (`start_ms`,`end_ms`);--> statement-breakpoint
CREATE TABLE `tasklists` (
	`account` text NOT NULL,
	`google_id` text NOT NULL,
	`title` text,
	`synced_at` integer,
	`deleted_at` integer,
	PRIMARY KEY(`account`, `google_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`account` text NOT NULL,
	`tasklist` text NOT NULL,
	`google_id` text NOT NULL,
	`title` text,
	`notes` text,
	`status` text,
	`due` text,
	`position` text,
	`parent` text,
	`google_updated` text,
	`due_time` text,
	`remind_at` integer,
	`sort_order` integer,
	`synced_at` integer,
	`deleted_at` integer,
	PRIMARY KEY(`account`, `tasklist`, `google_id`)
);
