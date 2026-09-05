ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS smtp_host varchar(255),
  ADD COLUMN IF NOT EXISTS smtp_port integer,
  ADD COLUMN IF NOT EXISTS smtp_user varchar(255),
  ADD COLUMN IF NOT EXISTS smtp_pass varchar(512),
  ADD COLUMN IF NOT EXISTS smtp_from varchar(255);