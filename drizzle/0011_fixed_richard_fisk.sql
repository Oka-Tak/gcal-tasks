CREATE TABLE `note_audios` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`seq` integer NOT NULL,
	`label` text,
	`audio_path` text NOT NULL,
	`language` text,
	`transcript` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE INDEX `note_audios_note` ON `note_audios` (`note_id`);