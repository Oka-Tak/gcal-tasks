CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`amount_yen` integer NOT NULL,
	`category` text NOT NULL,
	`title` text,
	`note` text,
	`when_ms` integer NOT NULL,
	`source` text,
	`image_path` text,
	`created_at` integer,
	`updated_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `expenses_when` ON `expenses` (`when_ms`);