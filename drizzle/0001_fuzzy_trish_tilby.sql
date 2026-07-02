CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`agent` text,
	`status` text NOT NULL,
	`payload` text,
	`result` text,
	`error` text,
	`created_at` integer,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `agent_jobs_status` ON `agent_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`task_key` text,
	`role` text NOT NULL,
	`content` text,
	`agent` text,
	`job_id` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `chats_thread` ON `chats` (`thread_id`);--> statement-breakpoint
CREATE TABLE `logs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`note` text,
	`start_ms` integer,
	`end_ms` integer,
	`tags` text,
	`metrics` text,
	`source` text,
	`image_path` text,
	`created_at` integer,
	`updated_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `logs_range` ON `logs` (`start_ms`,`end_ms`);--> statement-breakpoint
CREATE INDEX `logs_kind` ON `logs` (`kind`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `estimated_min` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `actual_min` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `difficulty` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `energy` integer;