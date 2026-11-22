CREATE TABLE `event_discord` (
	`event_id` integer PRIMARY KEY NOT NULL,
	`review_channel_id` text,
	`review_message_id` text,
	`reviewed_by` text,
	`reviewed_at` text,
	`guild_event_id` text,
	`guild_event_hash` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
