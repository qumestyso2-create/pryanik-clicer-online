-- PRYANIK CLICKER ONLINE: базовая схема. Выполнять в Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  telegram_id text unique not null,
  username text,
  first_name text not null default 'Игрок',
  last_name text,
  photo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_state (
  player_id uuid primary key references public.players(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  total_earned bigint not null default 0 check (total_earned >= 0),
  total_clicks bigint not null default 0 check (total_clicks >= 0),
  click_power bigint not null default 1 check (click_power >= 1),
  auto_income bigint not null default 0 check (auto_income >= 0),
  multiplier numeric(10,2) not null default 1.00,
  click_level integer not null default 0,
  auto_level integer not null default 0,
  multiplier_level integer not null default 0,
  last_daily_at timestamptz,
  last_tick_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.promo_codes (
  code text primary key,
  reward bigint not null check (reward > 0),
  max_uses integer,
  uses integer not null default 0,
  expires_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.developer_suggestions (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  message text not null check (char_length(message) between 5 and 1000),
  created_at timestamptz not null default now()
);

create table if not exists public.promo_redemptions (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.players(id) on delete cascade,
  code text not null references public.promo_codes(code),
  redeemed_at timestamptz not null default now(),
  unique(player_id, code)
);

create or replace view public.leaderboard as
select p.telegram_id,p.username,p.first_name,g.balance,g.total_earned,
       (1 + floor(sqrt(greatest(g.total_earned,0)::numeric / 1000)))::integer as level
from public.players p join public.game_state g on g.player_id=p.id;


create or replace function public.collect_passive_income(p_player_id uuid)
returns public.game_state language plpgsql security definer set search_path=public as $$
declare g game_state; elapsed_seconds bigint; earned bigint;
begin
  select * into g from game_state where player_id=p_player_id for update;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  elapsed_seconds:=greatest(0,least(28800,floor(extract(epoch from (now()-g.last_tick_at)))::bigint));
  earned:=elapsed_seconds*g.auto_income;
  update game_state set balance=balance+earned,total_earned=total_earned+earned,last_tick_at=now(),updated_at=now()
  where player_id=p_player_id returning * into g;
  return g;
end; $$;

create or replace function public.game_click(p_player_id uuid)
returns public.game_state language plpgsql security definer set search_path=public as $$
declare result public.game_state;
begin
  update game_state
  set balance=balance+click_power,
      total_earned=total_earned+click_power,
      total_clicks=total_clicks+1,
      updated_at=now()
  where player_id=p_player_id returning * into result;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  return result;
end; $$;

create or replace function public.buy_upgrade(p_player_id uuid,p_type text)
returns public.game_state language plpgsql security definer set search_path=public as $$
declare g game_state; c bigint;
begin
  select * into g from game_state where player_id=p_player_id for update;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  if p_type='click_power' then c:=floor(50*power(1.55,g.click_level))::bigint;
  elsif p_type='auto_income' then c:=floor(150*power(1.62,g.auto_level))::bigint;
  elsif p_type='multiplier' then c:=floor(1200*power(2.15,g.multiplier_level))::bigint;
  else raise exception 'INVALID_UPGRADE'; end if;
  if g.balance<c then raise exception 'INSUFFICIENT_BALANCE'; end if;
  update game_state set
    balance=balance-c,
    click_power=case when p_type='click_power' then click_power+1 when p_type='multiplier' then floor(click_power*1.25)::bigint else click_power end,
    auto_income=case when p_type='auto_income' then auto_income+1 else auto_income end,
    click_level=click_level+case when p_type='click_power' then 1 else 0 end,
    auto_level=auto_level+case when p_type='auto_income' then 1 else 0 end,
    multiplier_level=multiplier_level+case when p_type='multiplier' then 1 else 0 end,
    multiplier=case when p_type='multiplier' then multiplier*1.25 else multiplier end,
    updated_at=now()
  where player_id=p_player_id returning * into g;
  return g;
end; $$;

create or replace function public.claim_daily_bonus(p_player_id uuid)
returns public.game_state language plpgsql security definer set search_path=public as $$
declare g game_state;
begin
  select * into g from game_state where player_id=p_player_id for update;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  if g.last_daily_at is not null and g.last_daily_at > now()-interval '24 hours' then raise exception 'COOLDOWN'; end if;
  update game_state set balance=balance+500,total_earned=total_earned+500,last_daily_at=now(),updated_at=now()
  where player_id=p_player_id returning * into g;
  return g;
end; $$;

create or replace function public.redeem_promo(p_player_id uuid,p_code text)
returns public.game_state language plpgsql security definer set search_path=public as $$
declare g game_state; p promo_codes;
begin
  select * into g from game_state where player_id=p_player_id for update;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  select * into p from promo_codes where code=upper(p_code) and enabled=true for update;
  if not found or (p.expires_at is not null and p.expires_at<now()) or (p.max_uses is not null and p.uses>=p.max_uses) then raise exception 'INVALID_PROMO'; end if;
  if exists(select 1 from promo_redemptions where player_id=p_player_id and code=p.code) then raise exception 'ALREADY_USED'; end if;
  insert into promo_redemptions(player_id,code) values(p_player_id,p.code);
  update promo_codes set uses=uses+1 where code=p.code;
  update game_state set balance=balance+p.reward,total_earned=total_earned+p.reward,updated_at=now()
  where player_id=p_player_id returning * into g;
  return g;
end; $$;

-- API использует service_role только на сервере. Прямой доступ из браузера запрещён.
alter table public.players enable row level security;
alter table public.game_state enable row level security;
alter table public.promo_codes enable row level security;
alter table public.promo_redemptions enable row level security;
alter table public.developer_suggestions enable row level security;
revoke all on public.players,public.game_state,public.promo_codes,public.promo_redemptions,public.developer_suggestions from anon,authenticated;
revoke all on function public.collect_passive_income(uuid) from public,anon,authenticated;
revoke all on function public.game_click(uuid) from public,anon,authenticated;
revoke all on function public.buy_upgrade(uuid,text) from public,anon,authenticated;
revoke all on function public.claim_daily_bonus(uuid) from public,anon,authenticated;
revoke all on function public.redeem_promo(uuid,text) from public,anon,authenticated;
grant execute on function public.collect_passive_income(uuid) to service_role;
grant execute on function public.game_click(uuid) to service_role;
grant execute on function public.buy_upgrade(uuid,text) to service_role;
grant execute on function public.claim_daily_bonus(uuid) to service_role;
grant execute on function public.redeem_promo(uuid,text) to service_role;

-- Пример создания промокода (запускать вручную в SQL Editor):
-- insert into public.promo_codes(code,reward,max_uses) values ('WELCOME',1000,500);
