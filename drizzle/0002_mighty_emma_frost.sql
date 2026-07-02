CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`chat_id` text,
	`job_id` text,
	`kind` text NOT NULL,
	`summary` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`created_at` integer,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `proposals_status` ON `proposals` (`status`);--> statement-breakpoint
CREATE INDEX `proposals_thread` ON `proposals` (`thread_id`);