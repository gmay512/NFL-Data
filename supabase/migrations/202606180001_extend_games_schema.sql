alter table public.games
  add column if not exists league_id integer references public.leagues(id),
  add column if not exists stage text,
  add column if not exists date_timezone text,
  add column if not exists game_time text,
  add column if not exists game_timestamp bigint,
  add column if not exists venue_name text,
  add column if not exists venue_city text,
  add column if not exists status_short varchar(4),
  add column if not exists status_long text,
  add column if not exists status_timer text,
  add column if not exists home_q1 integer,
  add column if not exists home_q2 integer,
  add column if not exists home_q3 integer,
  add column if not exists home_q4 integer,
  add column if not exists home_ot integer,
  add column if not exists home_total integer,
  add column if not exists away_q1 integer,
  add column if not exists away_q2 integer,
  add column if not exists away_q3 integer,
  add column if not exists away_q4 integer,
  add column if not exists away_ot integer,
  add column if not exists away_total integer;

alter table public.games
  alter column game_date type date using game_date::date;

alter table public.games
  add constraint games_status_short_check
    check (status_short is null or status_short in ('NS','Q1','Q2','Q3','Q4','OT','HT','FT','AOT','CANC','PST'));