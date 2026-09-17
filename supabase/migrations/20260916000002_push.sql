-- Web Push plumbing. Zero config: the `push` edge function generates its own VAPID keys on first use
-- and records its URL here, so every new notification row is delivered automatically.

create extension if not exists pg_net with schema extensions;

-- Server-only key/value store (RLS on, no policies → only service_role can touch it).
create table public.app_secrets (
  key text primary key,
  value text not null
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;

create or replace function public.get_vapid_public_key() returns text
language sql stable security definer set search_path = '' as $$
  select value from public.app_secrets where key = 'vapid_public_key';
$$;
grant execute on function public.get_vapid_public_key() to anon, authenticated;

-- Called by the push function (service_role): marks a notification sent and returns what to deliver.
create or replace function public.push_claim(p_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n public.notifications;
begin
  update public.notifications set sent_at = now() where id = p_id and sent_at is null returning * into n;
  if n.id is null then return null; end if;
  return jsonb_build_object(
    'title', n.title, 'body', n.body, 'kind', n.kind, 'game_id', n.game_id,
    'subscriptions', coalesce((select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'keys',
                       jsonb_build_object('p256dh', p256dh, 'auth', auth)))
                     from public.push_subscriptions where user_id = n.user_id), '[]'));
end $$;
revoke execute on function public.push_claim(bigint) from public, anon, authenticated;
grant execute on function public.push_claim(bigint) to service_role;

create or replace function private.dispatch_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  url text := (select value from public.app_secrets where key = 'push_function_url');
begin
  if url is not null and exists (select 1 from public.push_subscriptions where user_id = new.user_id) then
    perform net.http_post(url := url, body := jsonb_build_object('id', new.id),
                          headers := '{"Content-Type": "application/json"}'::jsonb);
  end if;
  return new;
end $$;

create trigger notifications_push after insert on public.notifications
  for each row execute function private.dispatch_push();

create or replace function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint;
$$;
revoke execute on function public.remove_push_subscription(text) from public, anon, authenticated;
grant execute on function public.remove_push_subscription(text) to service_role;
