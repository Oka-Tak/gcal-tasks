CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`days` text,
	`start_hm` text,
	`end_hm` text,
	`note` text,
	`active` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `asap` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority` integer;