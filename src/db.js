import pg from 'pg';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

export async function migrate() {
  await pool.query(`
    create table if not exists businesses (
      id serial primary key,
      name text not null,
      website_url text not null,
      tone text not null default 'friendly and professional',
      notes text not null default '',
      handoff_message text not null default 'Thanks for your message! I have passed this to our team and someone will get back to you shortly.',
      bot_enabled boolean not null default true,
      wa_status text not null default 'disconnected',
      wa_number text,
      crawl_status text not null default 'never',
      crawled_at timestamptz,
      pages_count int not null default 0,
      created_at timestamptz not null default now()
    );

    create table if not exists chunks (
      id serial primary key,
      business_id int not null references businesses(id) on delete cascade,
      url text,
      title text,
      content text not null,
      tsv tsvector generated always as (to_tsvector('english', content)) stored
    );
    create index if not exists chunks_biz_idx on chunks(business_id);
    create index if not exists chunks_tsv_idx on chunks using gin(tsv);

    create table if not exists messages (
      id bigserial primary key,
      business_id int not null references businesses(id) on delete cascade,
      chat_jid text not null,
      role text not null,
      text text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists messages_chat_idx on messages(business_id, chat_jid, id desc);

    create table if not exists chat_state (
      business_id int not null references businesses(id) on delete cascade,
      chat_jid text not null,
      paused_until timestamptz,
      primary key (business_id, chat_jid)
    );
  `);
  // Columns added after the first release (safe to run every start).
  await pool.query(`
    alter table businesses add column if not exists learned text not null default '';
    alter table businesses add column if not exists learned_at timestamptz;
    alter table businesses add column if not exists learn_status text not null default 'never';
    alter table messages add column if not exists source text not null default 'live';
    alter table messages add column if not exists wa_id text;
    create unique index if not exists messages_wa_id_idx on messages(business_id, wa_id) where wa_id is not null;
  `);
}
