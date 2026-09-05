-- Migration: Add live agent support chat system
-- Adds agent assignment, conversation status, ticket management, and agent availability tracking

-- Create new enums
DO $$ BEGIN
  CREATE TYPE support_conversation_status AS ENUM ('waiting', 'active', 'closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE support_ticket_status AS ENUM ('open', 'in_review', 'closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Extend support_conversations table
ALTER TABLE support_conversations
  ADD COLUMN IF NOT EXISTS category varchar(100),
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS status support_conversation_status NOT NULL DEFAULT 'closed',
  ADD COLUMN IF NOT EXISTS ticket_status support_ticket_status NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_name varchar(255),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;

-- Extend support_messages table
ALTER TABLE support_messages
  ADD COLUMN IF NOT EXISTS sender_name varchar(255);

-- Create support_agent_status table
CREATE TABLE IF NOT EXISTS support_agent_status (
  admin_user_id uuid PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
  is_available boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Set existing conversations to 'closed' status (they were AI-only)
UPDATE support_conversations SET status = 'closed' WHERE status IS NULL;
