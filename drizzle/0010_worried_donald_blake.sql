CREATE TABLE `materials` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook` text NOT NULL,
	`event_key` text,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`size` integer,
	`owui_file_id` text,
	`created_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `materials_notebook` ON `materials` (`notebook`);--> statement-breakpoint
ALTER TABLE `notes` ADD `notebook` text;--> statement-breakpoint
ALTER TABLE `notes` ADD `owui_file_id` text;