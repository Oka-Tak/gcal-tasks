CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text,
	`title` text,
	`content` text,
	`transcript` text,
	`status` text NOT NULL,
	`error` text,
	`audio_path` text,
	`job_id` text,
	`created_at` integer,
	`updated_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `notes_event` ON `notes` (`event_key`);