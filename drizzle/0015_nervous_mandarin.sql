CREATE TABLE `travel_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`from_place` text NOT NULL,
	`to_place` text NOT NULL,
	`mode` text DEFAULT '未指定' NOT NULL,
	`minutes` integer,
	`note` text,
	`source` text,
	`created_at` integer,
	`updated_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `travel_routes_pair` ON `travel_routes` (`from_place`,`to_place`);