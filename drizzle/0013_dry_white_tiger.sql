CREATE TABLE `glossary` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`aliases` text,
	`definition` text,
	`created_at` integer,
	`updated_at` integer
);
