-- Hunger Games: core schema, security, and server-side game rules.
-- Clients only READ tables (through RLS). Every write goes through a security definer RPC below.

-- The early prototype used a table named "players"; keep its (empty) data out of the way.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'players' and column_name = 'first_name') then
    alter table public.players rename to legacy_players;
  end if;
end $$;

create schema if not exists private;

-- ───────────────────────── tables ─────────────────────────

create table public.gamemaker_profiles (
  user_id uuid primary key references auth.users on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  created_at timestamptz not null default now()
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null check (char_length(name) between 1 and 60),
  status text not null default 'lobby' check (status in ('lobby', 'active', 'ended')),
  config jsonb not null,
  -- Materialized storm plan, written when the game starts:
  -- [{ "c": [lng, lat], "r": meters, "revealAt": s, "shrinkStart": s, "shrinkEnd": s }, ...] (seconds since started_at)
  storm jsonb,
  storm_progress jsonb not null default '{"reveal": 0, "shrink": 0, "settled": 0}',
  spectator_token uuid not null default gen_random_uuid(),
  gm_invite_code text not null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);

create table public.game_gamemakers (
  game_id uuid not null references public.games on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (game_id, user_id)
);

create table public.game_spectators (
  game_id uuid not null references public.games on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  primary key (game_id, user_id)
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  color text not null default '#3b82f6',
  sort int not null default 0
);
create index on public.teams (game_id);

create table public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  name text not null,
  team_id uuid references public.teams on delete set null,
  status text not null default 'alive' check (status in ('alive', 'dead', 'removed')),
  death_cause text,
  joined_at timestamptz not null default now(),
  died_at timestamptz,
  unique (game_id, user_id)
);
create index on public.players (game_id);
create index on public.players (user_id);

-- Private per-player data: rejoin code (only the player + gamemakers can read it).
create table public.player_secrets (
  player_id uuid primary key references public.players on delete cascade,
  game_id uuid not null references public.games on delete cascade,
  rejoin_code text not null
);

-- Live position + server-tracked flags. Visibility is restricted (teammates, reveals, gamemakers).
create table public.player_state (
  player_id uuid primary key references public.players on delete cascade,
  game_id uuid not null references public.games on delete cascade,
  lng double precision,
  lat double precision,
  accuracy double precision,
  last_seen timestamptz,
  is_dark boolean not null default false,
  storm_since timestamptz,
  out_of_bounds boolean not null default false,
  shield_until timestamptz
);
create index on public.player_state (game_id);

create table public.location_history (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games on delete cascade,
  player_id uuid not null references public.players on delete cascade,
  lng double precision not null,
  lat double precision not null,
  recorded_at timestamptz not null default now()
);
create index on public.location_history (game_id, recorded_at);

create table public.chests (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games on delete cascade,
  lng double precision not null,
  lat double precision not null,
  claimed_by uuid references public.players on delete set null,
  claimed_at timestamptz
);
create index on public.chests (game_id);

-- Chest contents are hidden from players until opened.
create table public.chest_prizes (
  chest_id uuid primary key references public.chests on delete cascade,
  game_id uuid not null references public.games on delete cascade,
  prize jsonb not null
);

create table public.inventory (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games on delete cascade,
  player_id uuid not null references public.players on delete cascade,
  prize jsonb not null,
  chest_id uuid references public.chests on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
create index on public.inventory (player_id);

create table public.reveals (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games on delete cascade,
  viewer_player_id uuid not null references public.players on delete cascade,
  target_player_id uuid not null references public.players on delete cascade,
  expires_at timestamptz not null
);
create index on public.reveals (viewer_player_id, expires_at);

-- audience: 'all' (everyone in the game), 'gm' (gamemakers + spectators), 'team', 'player'
create table public.events (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games on delete cascade,
  type text not null,
  message text not null,
  audience text not null default 'all' check (audience in ('all', 'gm', 'team', 'player')),
  player_id uuid references public.players on delete cascade,
  team_id uuid references public.teams on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.events (game_id, id);

-- One row per recipient user. Inserting a row triggers a Web Push (if push is configured).
create table public.notifications (
  id bigint generated always as identity primary key,
  game_id uuid references public.games on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  title text not null,
  body text not null,
  kind text not null default 'info',
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on public.notifications (user_id, id);

create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index on public.push_subscriptions (user_id);

-- ───────────────────────── helpers ─────────────────────────

create or replace function private.is_gm(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.game_gamemakers where game_id = p_game and user_id = auth.uid());
$$;

create or replace function private.is_spectator(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.game_spectators where game_id = p_game and user_id = auth.uid());
$$;

create or replace function private.my_player(p_game uuid) returns public.players
language sql stable security definer set search_path = '' as $$
  select * from public.players where game_id = p_game and user_id = auth.uid();
$$;

create or replace function private.in_game(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_gm(p_game) or private.is_spectator(p_game)
      or exists (select 1 from public.players where game_id = p_game and user_id = auth.uid());
$$;

create or replace function private.is_real_user() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;

create or replace function private.can_see_position(p_player uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with target as (select id, game_id, team_id, status from public.players where id = p_player),
       me as (select p.* from public.players p join target t on p.game_id = t.game_id where p.user_id = auth.uid())
  select exists (select 1 from target t where private.is_gm(t.game_id) or private.is_spectator(t.game_id))
      or exists (select 1 from target t join me on true
                 where me.id = t.id
                    or (me.team_id is not null and me.team_id = t.team_id)
                    or exists (select 1 from public.reveals r
                               where r.viewer_player_id = me.id and r.target_player_id = t.id and r.expires_at > now()));
$$;

-- Great-circle distance in meters.
create or replace function private.dist_m(lng1 float8, lat1 float8, lng2 float8, lat2 float8) returns float8
language sql immutable set search_path = '' as $$
  select 2 * 6371008.8 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- Ray casting against a GeoJSON Polygon coordinates array ([outer, hole, hole...]).
create or replace function private.point_in_ring(p_lng float8, p_lat float8, ring jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  n int := jsonb_array_length(ring);
  i int; j int;
  xi float8; yi float8; xj float8; yj float8;
  inside boolean := false;
begin
  j := n - 1;
  for i in 0 .. n - 1 loop
    xi := (ring -> i ->> 0)::float8; yi := (ring -> i ->> 1)::float8;
    xj := (ring -> j ->> 0)::float8; yj := (ring -> j ->> 1)::float8;
    if ((yi > p_lat) <> (yj > p_lat)) and (p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi) then
      inside := not inside;
    end if;
    j := i;
  end loop;
  return inside;
end $$;

create or replace function private.point_in_polygon(p_lng float8, p_lat float8, poly jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  k int;
begin
  if poly is null or jsonb_array_length(poly) = 0 then return true; end if;
  if not private.point_in_ring(p_lng, p_lat, poly -> 0) then return false; end if;
  for k in 1 .. jsonb_array_length(poly) - 1 loop
    if private.point_in_ring(p_lng, p_lat, poly -> k) then return false; end if;
  end loop;
  return true;
end $$;

-- Current storm circle for a game at a moment in time. Mirrors src/lib/storm.js.
create or replace function private.storm_at(p_game public.games, p_at timestamptz,
  out lng float8, out lat float8, out r float8, out settled int, out shrinking int, out revealed int)
language plpgsql stable set search_path = '' as $$
declare
  t float8;
  n int;
  i int;
  cur jsonb; nxt jsonb; f float8;
begin
  if p_game.storm is null or p_game.started_at is null then return; end if;
  t := extract(epoch from p_at - p_game.started_at);
  n := jsonb_array_length(p_game.storm);
  settled := 0; shrinking := 0; revealed := 0;
  for i in 1 .. n - 1 loop
    if t >= (p_game.storm -> i ->> 'revealAt')::float8 then revealed := i; end if;
    if t >= (p_game.storm -> i ->> 'shrinkStart')::float8 then shrinking := i; end if;
    if t >= (p_game.storm -> i ->> 'shrinkEnd')::float8 then settled := i; end if;
  end loop;
  cur := p_game.storm -> settled;
  if shrinking > settled then
    nxt := p_game.storm -> shrinking;
    f := (t - (nxt ->> 'shrinkStart')::float8)
         / greatest((nxt ->> 'shrinkEnd')::float8 - (nxt ->> 'shrinkStart')::float8, 0.001);
    lng := (cur -> 'c' ->> 0)::float8 + ((nxt -> 'c' ->> 0)::float8 - (cur -> 'c' ->> 0)::float8) * f;
    lat := (cur -> 'c' ->> 1)::float8 + ((nxt -> 'c' ->> 1)::float8 - (cur -> 'c' ->> 1)::float8) * f;
    r := (cur ->> 'r')::float8 + ((nxt ->> 'r')::float8 - (cur ->> 'r')::float8) * f;
  else
    lng := (cur -> 'c' ->> 0)::float8;
    lat := (cur -> 'c' ->> 1)::float8;
    r := (cur ->> 'r')::float8;
  end if;
end $$;

create or replace function private.random_code(len int) returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, len);
$$;

create or replace function private.cfg_num(p_game public.games, path text[], fallback float8) returns float8
language sql immutable set search_path = '' as $$
  select coalesce((p_game.config #>> path)::float8, fallback);
$$;

create or replace function private.log_event(p_game uuid, p_type text, p_message text, p_audience text default 'all',
  p_player uuid default null, p_team uuid default null, p_data jsonb default '{}') returns void
language sql security definer set search_path = '' as $$
  insert into public.events (game_id, type, message, audience, player_id, team_id, data)
  values (p_game, p_type, p_message, p_audience, p_player, p_team, p_data);
$$;

create or replace function private.notify_player(p_player uuid, p_title text, p_body text, p_kind text default 'info') returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (game_id, user_id, title, body, kind)
  select game_id, user_id, p_title, p_body, p_kind from public.players where id = p_player and status <> 'removed';
$$;

create or replace function private.notify_gms(p_game uuid, p_title text, p_body text, p_kind text default 'info') returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (game_id, user_id, title, body, kind)
  select p_game, user_id, p_title, p_body, p_kind from public.game_gamemakers where game_id = p_game;
$$;

create or replace function private.notify_players(p_game uuid, p_team uuid, p_title text, p_body text, p_kind text default 'info') returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (game_id, user_id, title, body, kind)
  select p_game, user_id, p_title, p_body, p_kind from public.players
  where game_id = p_game and status = 'alive' and (p_team is null or team_id = p_team);
$$;

create or replace function private.eliminate(p_player uuid, p_cause text) returns void
language plpgsql security definer set search_path = '' as $
declare
  pl public.players;
  alive_teams int; alive_players int; teamless int;
  how text;
begin
  update public.players set status = 'dead', death_cause = p_cause, died_at = now()
  where id = p_player and status = 'alive' returning * into pl;
  if pl.id is null then return; end if;

  how := case p_cause
           when 'storm' then ' was caught by the storm'
           when 'shot' then ' was shot'
           when 'offline' then ' dropped out (offline too long)'
           else ' was eliminated'
         end;
  perform private.log_event(pl.game_id, 'eliminated', pl.name || how, 'all', pl.id, pl.team_id,
    jsonb_build_object('cause', p_cause));

  perform private.notify_player(pl.id, 'You''re out',
    case p_cause
      when 'storm' then 'The storm got you.'
      when 'shot' then 'You were shot. Head back to the gamemakers.'
      when 'offline' then 'You were marked out for being offline too long.'
      else 'A gamemaker marked you as eliminated.'
    end, 'death');

  select count(distinct team_id), count(*), count(*) filter (where team_id is null)
    into alive_teams, alive_players, teamless
  from public.players where game_id = pl.game_id and status = 'alive';

  insert into public.notifications (game_id, user_id, title, body, kind)
  select pl.game_id, user_id, pl.name || how, alive_players || ' still alive.', 'death'
  from public.players where game_id = pl.game_id and status = 'alive';

  perform private.notify_gms(pl.game_id, pl.name || how, alive_players || ' still alive.', 'death');

  if (alive_players = 1 or (teamless = 0 and alive_teams = 1))
     and not exists (select 1 from public.events where game_id = pl.game_id and type = 'last_standing') then
    perform private.log_event(pl.game_id, 'last_standing', 'Only one team is left standing!', 'gm');
    perform private.notify_gms(pl.game_id, 'We have a winner', 'Only one team is left. End the game when ready.', 'win');
  end if;
end $;

-- ───────────────────────── RLS ─────────────────────────

alter table public.gamemaker_profiles enable row level security;
alter table public.games enable row level security;
alter table public.game_gamemakers enable row level security;
alter table public.game_spectators enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.player_secrets enable row level security;
alter table public.player_state enable row level security;
alter table public.location_history enable row level security;
alter table public.chests enable row level security;
alter table public.chest_prizes enable row level security;
alter table public.inventory enable row level security;
alter table public.reveals enable row level security;
alter table public.events enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "gamemakers read profiles" on public.gamemaker_profiles for select to authenticated
  using (private.is_real_user());
create policy "participants read game" on public.games for select to authenticated
  using (private.in_game(id));
create policy "participants read gamemakers" on public.game_gamemakers for select to authenticated
  using (private.in_game(game_id));
create policy "gamemakers read spectators" on public.game_spectators for select to authenticated
  using (private.is_gm(game_id) or user_id = auth.uid());
create policy "participants read teams" on public.teams for select to authenticated
  using (private.in_game(game_id));
create policy "participants read players" on public.players for select to authenticated
  using (private.in_game(game_id));
create policy "own or gm reads rejoin code" on public.player_secrets for select to authenticated
  using (private.is_gm(game_id) or exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid()));
create policy "visible positions" on public.player_state for select to authenticated
  using (private.can_see_position(player_id));
create policy "gm and spectators read history" on public.location_history for select to authenticated
  using (private.is_gm(game_id) or private.is_spectator(game_id));
create policy "participants read chests" on public.chests for select to authenticated
  using (private.is_gm(game_id) or private.is_spectator(game_id)
         or (private.in_game(game_id) and (select coalesce((config #>> '{chests,visibleToPlayers}')::boolean, true)
                                           from public.games g where g.id = game_id)));
create policy "gm reads prizes" on public.chest_prizes for select to authenticated
  using (private.is_gm(game_id));
create policy "own or gm inventory" on public.inventory for select to authenticated
  using (private.is_gm(game_id) or exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid()));
create policy "own reveals" on public.reveals for select to authenticated
  using (private.is_gm(game_id) or exists (select 1 from public.players p where p.id = viewer_player_id and p.user_id = auth.uid()));
create policy "events by audience" on public.events for select to authenticated
  using (private.is_gm(game_id) or private.is_spectator(game_id)
         or (audience = 'all' and private.in_game(game_id))
         or (audience = 'player' and exists (select 1 from public.players p where p.id = player_id and p.user_id = auth.uid()))
         or (audience = 'team' and exists (select 1 from public.players p where p.game_id = events.game_id
                                            and p.team_id = events.team_id and p.user_id = auth.uid())));
create policy "own notifications" on public.notifications for select to authenticated
  using (user_id = auth.uid());
create policy "own push subscriptions" on public.push_subscriptions for select to authenticated
  using (user_id = auth.uid());

-- ───────────────────────── RPCs: gamemakers ─────────────────────────

create or replace function public.gm_claim_username(p_username text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_real_user() then raise exception 'Gamemaker account required'; end if;
  insert into public.gamemaker_profiles (user_id, username) values (auth.uid(), lower(p_username))
  on conflict (user_id) do nothing;
end $$;

create or replace function public.gm_create_game(p_name text, p_config jsonb) returns public.games
language plpgsql security definer set search_path = '' as $$
declare
  g public.games;
  ch jsonb;
  new_chest uuid;
begin
  if not private.is_real_user() then raise exception 'Gamemaker account required'; end if;
  loop
    begin
      insert into public.games (code, name, config, gm_invite_code, created_by)
      values (private.random_code(5), p_name, jsonb_set(p_config, '{chests}', coalesce(p_config -> 'chests', '{}') - 'items'),
              private.random_code(8), auth.uid())
      returning * into g;
      exit;
    exception when unique_violation then
      -- join code collision; try again
    end;
  end loop;
  insert into public.game_gamemakers (game_id, user_id) values (g.id, auth.uid());

  for ch in select * from jsonb_array_elements(coalesce(p_config #> '{chests,items}', '[]')) loop
    insert into public.chests (game_id, lng, lat)
    values (g.id, (ch -> 'position' ->> 0)::float8, (ch -> 'position' ->> 1)::float8)
    returning id into new_chest;
    insert into public.chest_prizes (chest_id, game_id, prize) values (new_chest, g.id, ch -> 'prize');
  end loop;

  insert into public.teams (game_id, name, color, sort)
  select g.id, t ->> 'name', coalesce(t ->> 'color', '#3b82f6'), (ord - 1)::int
  from jsonb_array_elements(coalesce(p_config -> 'teams', '[]')) with ordinality as x(t, ord);

  return g;
end $$;

create or replace function public.gm_join_game(p_invite_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid;
begin
  if not private.is_real_user() then raise exception 'Gamemaker account required'; end if;
  select id into gid from public.games where gm_invite_code = upper(trim(p_invite_code));
  if gid is null then raise exception 'Invalid gamemaker invite code'; end if;
  insert into public.game_gamemakers (game_id, user_id) values (gid, auth.uid()) on conflict do nothing;
  return gid;
end $$;

create or replace function public.gm_upsert_team(p_game uuid, p_team uuid, p_name text, p_color text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  tid uuid := p_team;
begin
  if not private.is_gm(p_game) then raise exception 'Not a gamemaker of this game'; end if;
  if tid is null then
    insert into public.teams (game_id, name, color, sort)
    values (p_game, p_name, p_color, (select coalesce(max(sort) + 1, 0) from public.teams where game_id = p_game))
    returning id into tid;
  else
    update public.teams set name = p_name, color = p_color where id = tid and game_id = p_game;
  end if;
  return tid;
end $$;

create or replace function public.gm_delete_team(p_team uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := (select game_id from public.teams where id = p_team);
begin
  if gid is null then raise exception 'That team no longer exists'; end if;
  if not private.is_gm(gid) then raise exception 'Not a gamemaker of this game'; end if;
  delete from public.teams where id = p_team;
end $$;

create or replace function public.gm_set_team(p_player uuid, p_team uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := (select game_id from public.players where id = p_player);
begin
  if not private.is_gm(gid) then raise exception 'Not allowed'; end if;
  if p_team is not null and not exists (select 1 from public.teams where id = p_team and game_id = gid) then
    raise exception 'Team is not in this game';
  end if;
  update public.players set team_id = p_team where id = p_player;
end $$;

-- status: 'alive' (revive), 'dead', 'removed'
-- p_cause: 'shot' | 'offline' | null (unspecified). Only used when p_status = 'dead'.
create or replace function public.gm_set_player_status(p_player uuid, p_status text, p_cause text default null) returns void
language plpgsql security definer set search_path = '' as $
declare
  pl public.players := (select p from public.players p where p.id = p_player);
begin
  if not private.is_gm(pl.game_id) then raise exception 'Not allowed'; end if;
  if p_status = 'dead' then
    perform private.eliminate(p_player, coalesce(p_cause, 'gamemaker'));
  elsif p_status = 'removed' then
    update public.players set status = 'removed', died_at = coalesce(died_at, now()) where id = p_player;
    perform private.log_event(pl.game_id, 'removed', pl.name || ' was removed from the game', 'all', pl.id, pl.team_id);
  elsif p_status = 'alive' then
    update public.players set status = 'alive', death_cause = null, died_at = null where id = p_player;
    update public.player_state set storm_since = null where player_id = p_player;
    perform private.log_event(pl.game_id, 'revived', pl.name || ' is back in the game', 'all', pl.id, pl.team_id);
    perform private.notify_player(pl.id, 'You''re back!', 'A gamemaker brought you back into the game.');
  else
    raise exception 'Unknown status %', p_status;
  end if;
end $;

create or replace function public.gm_start_game(p_game uuid, p_storm jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_gm(p_game) then raise exception 'Not allowed'; end if;
  update public.games set status = 'active', started_at = now(), storm = p_storm,
    storm_progress = '{"reveal": 0, "shrink": 0, "settled": 0}'
  where id = p_game and status = 'lobby';
  if not found then raise exception 'Game already started'; end if;
  -- Everyone gets a fresh "went dark" window at the start, even if they were idle in the lobby.
  update public.player_state set last_seen = now(), is_dark = false, storm_since = null
  where game_id = p_game;
  perform private.log_event(p_game, 'started', 'The game has started. Good luck!');
  perform private.notify_players(p_game, null, 'The game has started', 'Keep this app open with the screen on. Good luck!', 'start');
end $$;

create or replace function public.gm_end_game(p_game uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_gm(p_game) then raise exception 'Not allowed'; end if;
  update public.games set status = 'ended', ended_at = now() where id = p_game and status <> 'ended';
  perform private.log_event(p_game, 'ended', 'Game over!');
  perform private.notify_players(p_game, null, 'Game over', 'The gamemaker has ended the game.', 'end');
end $$;

-- target: 'all' | 'team' (p_target_id = team id) | 'player' (p_target_id = player id)
create or replace function public.gm_send_message(p_game uuid, p_target text, p_target_id uuid, p_title text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_gm(p_game) then raise exception 'Not allowed'; end if;
  if p_target = 'all' then
    insert into public.notifications (game_id, user_id, title, body, kind)
    select p_game, user_id, p_title, p_body, 'message' from public.players where game_id = p_game and status <> 'removed';
    perform private.log_event(p_game, 'message', p_title || ': ' || p_body, 'all');
  elsif p_target = 'team' then
    insert into public.notifications (game_id, user_id, title, body, kind)
    select p_game, user_id, p_title, p_body, 'message' from public.players where game_id = p_game and team_id = p_target_id and status <> 'removed';
    perform private.log_event(p_game, 'message', p_title || ': ' || p_body, 'team', null, p_target_id);
  elsif p_target = 'player' then
    perform private.notify_player(p_target_id, p_title, p_body, 'message');
    perform private.log_event(p_game, 'message', p_title || ': ' || p_body, 'player', p_target_id);
  end if;
end $$;

-- ───────────────────────── RPCs: players & spectators ─────────────────────────

create or replace function public.join_game(p_code text, p_name text) returns public.players
language plpgsql security definer set search_path = '' as $$
declare
  g public.games;
  pl public.players;
  clean text := regexp_replace(trim(p_name), '\s+', ' ', 'g');
  max_len int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into g from public.games where code = upper(trim(p_code));
  if g.id is null then raise exception 'No game with that code'; end if;
  if g.status = 'ended' then raise exception 'That game has ended'; end if;
  max_len := private.cfg_num(g, '{rules,maxNameLength}', 16)::int;
  if char_length(clean) < 1 or char_length(clean) > max_len then
    raise exception 'Name must be 1-% characters', max_len;
  end if;

  select * into pl from public.players where game_id = g.id and user_id = auth.uid();
  if pl.id is not null then return pl; end if;

  if g.status = 'active' and not coalesce((g.config #>> '{rules,allowLateJoin}')::boolean, false) then
    raise exception 'This game has already started';
  end if;
  if exists (select 1 from public.players where game_id = g.id and lower(name) = lower(clean) and status <> 'removed') then
    raise exception 'Someone already has that name';
  end if;

  insert into public.players (game_id, user_id, name) values (g.id, auth.uid(), clean) returning * into pl;
  insert into public.player_secrets (player_id, game_id, rejoin_code) values (pl.id, g.id, private.random_code(6));
  insert into public.player_state (player_id, game_id, last_seen) values (pl.id, g.id, case when g.status = 'active' then now() end);
  perform private.log_event(g.id, 'joined', clean || ' joined', 'gm', pl.id);
  return pl;
end $$;

-- Move an existing player onto this device (e.g. joined in Safari, then added to the home screen).
create or replace function public.rejoin_game(p_code text, p_rejoin_code text) returns public.players
language plpgsql security definer set search_path = '' as $$
declare
  pl public.players;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select p.* into pl from public.players p
    join public.games g on g.id = p.game_id
    join public.player_secrets s on s.player_id = p.id
  where g.code = upper(trim(p_code)) and s.rejoin_code = upper(trim(p_rejoin_code));
  if pl.id is null then raise exception 'Rejoin code not found'; end if;
  delete from public.players where game_id = pl.game_id and user_id = auth.uid() and id <> pl.id;
  update public.players set user_id = auth.uid() where id = pl.id returning * into pl;
  return pl;
end $$;

create or replace function public.spectate(p_token uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id into gid from public.games where spectator_token = p_token;
  if gid is null then raise exception 'Invalid spectator link'; end if;
  insert into public.game_spectators (game_id, user_id) values (gid, auth.uid()) on conflict do nothing;
  return gid;
end $$;

create or replace function public.server_now() returns timestamptz
language sql stable set search_path = '' as $$ select now(); $$;

-- Core per-player rules shared by location reports and the cron tick.
create or replace function private.evaluate_player(g public.games, pl public.players, ps public.player_state) returns void
language plpgsql security definer set search_path = '' as $$
declare
  st record;
  outside boolean;
  oob boolean;
  death_sec float8 := private.cfg_num(g, '{rules,stormDeathSeconds}', 10);
  dark_sec float8 := private.cfg_num(g, '{rules,darkAfterSeconds}', 15);
begin
  if g.status <> 'active' or pl.status <> 'alive' then return; end if;

  -- Went dark: no location report for a while.
  if not ps.is_dark and coalesce(ps.last_seen, g.started_at) < now() - make_interval(secs => dark_sec) then
    update public.player_state set is_dark = true where player_id = pl.id;
    perform private.log_event(g.id, 'went_dark', pl.name || ' went dark (no location for ' || dark_sec::int || 's)', 'gm', pl.id, pl.team_id);
    perform private.notify_gms(g.id, pl.name || ' went dark', 'No location updates for ' || dark_sec::int || ' seconds.', 'dark');
    perform private.notify_player(pl.id, 'You went dark!', 'Open the app and keep your screen on. The gamemakers can''t see you.', 'dark');
  end if;

  if ps.lng is null then return; end if;

  -- Storm
  st := private.storm_at(g, now());
  if st.r is not null then
    outside := private.dist_m(ps.lng, ps.lat, st.lng, st.lat) > st.r
               and (ps.shield_until is null or ps.shield_until < now());
    if outside and ps.storm_since is null then
      update public.player_state set storm_since = now() where player_id = pl.id;
      perform private.notify_player(pl.id, 'You''re in the storm!',
        'Get back inside the circle within ' || death_sec::int || ' seconds.', 'storm');
    elsif outside and ps.storm_since <= now() - make_interval(secs => death_sec) then
      perform private.eliminate(pl.id, 'storm');
    elsif not outside and ps.storm_since is not null then
      update public.player_state set storm_since = null where player_id = pl.id;
    end if;
  end if;

  -- Out of bounds
  oob := not private.point_in_polygon(ps.lng, ps.lat, g.config -> 'playArea');
  if oob and not ps.out_of_bounds then
    update public.player_state set out_of_bounds = true where player_id = pl.id;
    perform private.log_event(g.id, 'out_of_bounds', pl.name || ' left the play area', 'gm', pl.id, pl.team_id);
    perform private.notify_gms(g.id, 'Out of bounds', pl.name || ' left the play area.', 'bounds');
    perform private.notify_player(pl.id, 'Out of bounds!', 'Head back into the play area.', 'bounds');
  elsif not oob and ps.out_of_bounds then
    update public.player_state set out_of_bounds = false where player_id = pl.id;
    perform private.log_event(g.id, 'in_bounds', pl.name || ' is back in the play area', 'gm', pl.id, pl.team_id);
  end if;
end $$;

create or replace function public.report_location(p_game uuid, p_lng float8, p_lat float8, p_accuracy float8) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.games;
  pl public.players;
  ps public.player_state;
begin
  select * into pl from public.players where game_id = p_game and user_id = auth.uid();
  if pl.id is null then raise exception 'Not in this game'; end if;
  select * into g from public.games where id = p_game;

  update public.player_state
     set lng = p_lng, lat = p_lat, accuracy = p_accuracy, last_seen = now()
   where player_id = pl.id
  returning * into ps;

  if ps.is_dark then
    update public.player_state set is_dark = false where player_id = pl.id returning * into ps;
    if g.status = 'active' and pl.status = 'alive' then
      perform private.log_event(g.id, 'reconnected', pl.name || ' is back online', 'gm', pl.id, pl.team_id);
    end if;
  end if;

  if g.status <> 'active' or pl.status <> 'alive' then return jsonb_build_object('claimed', '[]'::jsonb); end if;

  insert into public.location_history (game_id, player_id, lng, lat) values (g.id, pl.id, p_lng, p_lat);
  perform private.evaluate_player(g, pl, ps);
  return jsonb_build_object('claimed', '[]'::jsonb);
end $$;

-- Opens a chest the player is standing next to. Returns the prize, or raises a readable error.
create or replace function public.claim_chest(p_chest uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.games;
  pl public.players;
  ps public.player_state;
  ch public.chests;
  prize jsonb;
  radius float8;
  gap float8;
begin
  select * into ch from public.chests where id = p_chest;
  if ch.id is null then raise exception 'Chest not found'; end if;
  select * into g from public.games where id = ch.game_id;
  select * into pl from public.players where game_id = g.id and user_id = auth.uid();
  if pl.id is null then raise exception 'Not in this game'; end if;
  if g.status <> 'active' then raise exception 'The game isn''t running'; end if;
  if pl.status <> 'alive' then raise exception 'You''re out of the game'; end if;
  if ch.claimed_by is not null then
    raise exception '%', case when ch.claimed_by = pl.id then 'You already opened this one' else 'Someone else got there first' end;
  end if;

  select * into ps from public.player_state where player_id = pl.id;
  if ps.lng is null then raise exception 'No location yet — give your phone a moment'; end if;

  radius := private.cfg_num(g, '{chests,claimRadiusMeters}', 20);
  gap := private.dist_m(ps.lng, ps.lat, ch.lng, ch.lat);
  if gap > radius then
    raise exception 'Too far away — get within % m (you are % m away)', round(radius), round(gap);
  end if;

  update public.chests set claimed_by = pl.id, claimed_at = now()
  where id = ch.id and claimed_by is null
  returning * into ch;
  if ch.id is null then raise exception 'Someone else got there first'; end if;

  select cp.prize into prize from public.chest_prizes cp where cp.chest_id = ch.id;
  insert into public.inventory (game_id, player_id, prize, chest_id) values (g.id, pl.id, prize, ch.id);
  perform private.log_event(g.id, 'chest', pl.name || ' opened a chest: ' || coalesce(prize ->> 'label', 'prize'),
    'gm', pl.id, pl.team_id, jsonb_build_object('chest_id', ch.id, 'prize', prize));
  perform private.log_event(g.id, 'chest_public', 'A chest has been opened', 'all', null, null, jsonb_build_object('chest_id', ch.id));
  return prize;
end $$;

create or replace function public.use_item(p_item uuid, p_target uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  it public.inventory;
  pl public.players;
  target public.players;
  secs float8;
begin
  select * into it from public.inventory where id = p_item and used_at is null;
  if it.id is null then raise exception 'Item not found or already used'; end if;
  select * into pl from public.players where id = it.player_id and user_id = auth.uid();
  if pl.id is null then raise exception 'Not your item'; end if;
  if pl.status <> 'alive' then raise exception 'You''re out of the game'; end if;
  secs := coalesce((it.prize ->> 'seconds')::float8, 10);

  case it.prize ->> 'type'
    when 'reveal_enemy' then
      select * into target from public.players where id = p_target and game_id = pl.game_id and status = 'alive';
      if target.id is null then raise exception 'Choose a player who is still alive'; end if;
      if pl.team_id is not null and target.team_id = pl.team_id then raise exception 'Choose someone on another team'; end if;
      insert into public.reveals (game_id, viewer_player_id, target_player_id, expires_at)
      values (pl.game_id, pl.id, target.id, now() + make_interval(secs => secs));
      perform private.log_event(pl.game_id, 'item_used', pl.name || ' revealed ' || target.name || ' for ' || secs::int || 's', 'gm', pl.id, pl.team_id);
    when 'reveal_all_enemies' then
      insert into public.reveals (game_id, viewer_player_id, target_player_id, expires_at)
      select pl.game_id, pl.id, p.id, now() + make_interval(secs => secs)
      from public.players p where p.game_id = pl.game_id and p.status = 'alive' and p.id <> pl.id
        and (pl.team_id is null or p.team_id is distinct from pl.team_id);
      perform private.log_event(pl.game_id, 'item_used', pl.name || ' revealed all enemies for ' || secs::int || 's', 'gm', pl.id, pl.team_id);
    when 'storm_shield' then
      update public.player_state set shield_until = now() + make_interval(secs => secs), storm_since = null where player_id = pl.id;
      perform private.log_event(pl.game_id, 'item_used', pl.name || ' activated a storm shield for ' || secs::int || 's', 'gm', pl.id, pl.team_id);
    else
      perform private.log_event(pl.game_id, 'item_used', pl.name || ' used: ' || coalesce(it.prize ->> 'label', 'a prize'), 'gm', pl.id, pl.team_id);
      perform private.notify_gms(pl.game_id, 'Prize redeemed', pl.name || ' used: ' || coalesce(it.prize ->> 'label', 'a prize'), 'prize');
  end case;

  update public.inventory set used_at = now() where id = it.id;
end $$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth) values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $$;

-- ───────────────────────── tick (pg_cron) ─────────────────────────

create or replace function private.game_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare
  g public.games;
  r record;
  st record;
  prog jsonb;
  mins text;
begin
  delete from public.reveals where expires_at < now() - interval '1 minute';

  for g in select * from public.games where status = 'active' loop
    -- Storm phase announcements
    st := private.storm_at(g, now());
    prog := g.storm_progress;
    if st.revealed > (prog ->> 'reveal')::int then
      mins := ceil(((g.storm -> st.revealed ->> 'shrinkStart')::float8 - extract(epoch from now() - g.started_at)) / 60)::text;
      perform private.log_event(g.id, 'storm_reveal', 'The next safe zone has appeared. The storm moves in ' || mins || ' min.', 'all');
      perform private.notify_players(g.id, null, 'New safe zone', 'The storm starts closing in ' || mins || ' min. Check your map.', 'storm');
      prog := jsonb_set(prog, '{reveal}', to_jsonb(st.revealed));
    end if;
    if st.shrinking > (prog ->> 'shrink')::int then
      perform private.log_event(g.id, 'storm_shrink', 'The storm is closing in!', 'all');
      perform private.notify_players(g.id, null, 'The storm is closing in', 'Get inside the safe zone.', 'storm');
      prog := jsonb_set(prog, '{shrink}', to_jsonb(st.shrinking));
    end if;
    if prog is distinct from g.storm_progress then
      update public.games set storm_progress = prog where id = g.id;
    end if;

    for r in
      select p as pl, s as ps from public.players p join public.player_state s on s.player_id = p.id
      where p.game_id = g.id and p.status = 'alive'
    loop
      perform private.evaluate_player(g, r.pl, r.ps);
    end loop;
  end loop;
end $$;

-- ───────────────────────── grants ─────────────────────────

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on function private.is_gm, private.is_spectator, private.in_game, private.is_real_user,
  private.can_see_position, private.my_player to authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.gm_claim_username, public.gm_create_game, public.gm_join_game, public.gm_upsert_team,
  public.gm_delete_team, public.gm_set_team, public.gm_set_player_status, public.gm_start_game, public.gm_end_game,
  public.gm_send_message, public.join_game, public.rejoin_game, public.spectate, public.server_now,
  public.report_location, public.claim_chest, public.use_item, public.save_push_subscription to authenticated;

revoke insert, update, delete on all tables in schema public from anon, authenticated;
revoke all on public.push_subscriptions, public.player_secrets, public.chest_prizes from anon;

-- ───────────────────────── realtime ─────────────────────────

alter publication supabase_realtime add table public.games, public.teams, public.players, public.player_state,
  public.chests, public.inventory, public.reveals, public.events, public.notifications;

-- Realtime DELETE payloads only carry the primary key by default, so a `game_id=eq.…`
-- subscription filter never matches and clients never hear about deleted rows.
alter table public.teams replica identity full;
alter table public.players replica identity full;
alter table public.reveals replica identity full;

-- ───────────────────────── cron ─────────────────────────

create extension if not exists pg_cron;
select cron.schedule('hunger-games-tick', '1 seconds', 'select private.game_tick()');

-- Supabase's default privileges grant EXECUTE to authenticated directly; keep internals private.
revoke execute on all functions in schema private from authenticated;
grant execute on function private.is_gm, private.is_spectator, private.in_game, private.is_real_user,
  private.can_see_position to authenticated;
