CREATE TABLE IF NOT EXISTS `linkedin_import_jobs` (
 `id` text PRIMARY KEY NOT NULL,
 `owner` text NOT NULL,
 `url` text NOT NULL,
 `status` text NOT NULL DEFAULT 'pending',
 `stage` text NOT NULL DEFAULT 'trigger',
 `provider_ref` text,
 `payload` text,
 `candidates` text,
 `error` text,
 `attempts` integer NOT NULL DEFAULT 0,
 `lease_until` integer,
 `created` integer NOT NULL,
 `updated` integer NOT NULL,
 `expires` integer NOT NULL,
 `saved` integer NOT NULL DEFAULT 0,
 FOREIGN KEY (`owner`) REFERENCES `accounts`(`owner`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `linkedin_import_jobs_owner_created` ON `linkedin_import_jobs` (`owner`,`created`);
CREATE UNIQUE INDEX IF NOT EXISTS `linkedin_import_jobs_one_pending_owner` ON `linkedin_import_jobs` (`owner`) WHERE `status` = 'pending';
