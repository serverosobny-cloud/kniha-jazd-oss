--
-- PostgreSQL database dump
--


-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: calculate_distance(numeric, numeric, numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_distance(lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    R CONSTANT DECIMAL := 6371000; -- polomer Zeme v metroch
    dLat DECIMAL;
    dLon DECIMAL;
    a DECIMAL;
    c DECIMAL;
BEGIN
    dLat := radians(lat2 - lat1);
    dLon := radians(lon2 - lon1);
    
    a := sin(dLat/2) * sin(dLat/2) +
         cos(radians(lat1)) * cos(radians(lat2)) *
         sin(dLon/2) * sin(dLon/2);
    
    c := 2 * atan2(sqrt(a), sqrt(1-a));
    
    RETURN R * c;
END;
$$;


--
-- Name: find_geofence_zone(numeric, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_geofence_zone(p_lat numeric, p_lon numeric) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_zone_id INTEGER;
BEGIN
    SELECT id INTO v_zone_id
    FROM geofence_zones
    WHERE active = TRUE
        AND calculate_distance(latitude, longitude, p_lat, p_lon) <= radius_meters
    ORDER BY calculate_distance(latitude, longitude, p_lat, p_lon) ASC
    LIMIT 1;
    
    RETURN v_zone_id;
END;
$$;


--
-- Name: lock_period(integer, date, date, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lock_period(p_vehicle_id integer, p_period_start date, p_period_end date, p_locked_by integer, p_lock_reason text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_lock_id INTEGER;
    v_trips_count INTEGER;
    v_business_count INTEGER;
    v_private_count INTEGER;
    v_total_distance DECIMAL;
    v_hash TEXT;
BEGIN
    -- Overiť, že obdobie nie je už zamknuté
    IF EXISTS (
        SELECT 1 FROM period_locks
        WHERE vehicle_id = p_vehicle_id
            AND period_start <= p_period_end
            AND period_end >= p_period_start
    ) THEN
        RAISE EXCEPTION 'Obdobie je už čiastočne alebo úplne zamknuté';
    END IF;
    
    -- Overiť, že všetky jazdy v období sú potvrdené
    IF EXISTS (
        SELECT 1 FROM trips
        WHERE vehicle_id = p_vehicle_id
            AND DATE(start_time) BETWEEN p_period_start AND p_period_end
            AND status != 'CONFIRMED'
    ) THEN
        RAISE EXCEPTION 'Všetky jazdy v období musia byť potvrdené pred zamknutím';
    END IF;
    
    -- Získať štatistiky
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE trip_type = 'business'),
        COUNT(*) FILTER (WHERE trip_type = 'private'),
        COALESCE(SUM(distance_meters) / 1000, 0)
    INTO v_trips_count, v_business_count, v_private_count, v_total_distance
    FROM trips
    WHERE vehicle_id = p_vehicle_id
        AND DATE(start_time) BETWEEN p_period_start AND p_period_end;
    
    -- Vytvoriť hash pre integritu
    SELECT encode(digest(
        p_vehicle_id::TEXT || p_period_start::TEXT || p_period_end::TEXT || 
        v_trips_count::TEXT || v_total_distance::TEXT || NOW()::TEXT,
        'sha256'
    ), 'hex') INTO v_hash;
    
    -- Vytvoriť záznam zamknutia
    INSERT INTO period_locks (
        vehicle_id, period_start, period_end,
        locked_by, lock_reason,
        trips_count, business_trips_count, private_trips_count,
        total_distance_km, hash_signature
    ) VALUES (
        p_vehicle_id, p_period_start, p_period_end,
        p_locked_by, p_lock_reason,
        v_trips_count, v_business_count, v_private_count,
        v_total_distance, v_hash
    ) RETURNING id INTO v_lock_id;
    
    -- Zamknúť všetky jazdy v období
    UPDATE trips
    SET 
        period_locked = TRUE,
        locked_at = NOW(),
        locked_by = p_locked_by,
        status = 'LOCKED'
    WHERE vehicle_id = p_vehicle_id
        AND DATE(start_time) BETWEEN p_period_start AND p_period_end;
    
    RETURN v_lock_id;
END;
$$;


--
-- Name: log_trip_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_trip_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_changed_by INTEGER;
    v_field_name TEXT;
    v_old_value TEXT;
    v_new_value TEXT;
BEGIN
    -- Získať ID používateľa z context alebo použiť created_by/last_modified_by
    v_changed_by := COALESCE(
        current_setting('app.current_user_id', TRUE)::INTEGER,
        NEW.last_modified_by,
        NEW.created_by
    );
    
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO trip_audit_log (trip_id, action, changed_by, new_value)
        VALUES (NEW.id, 'CREATED', v_changed_by, row_to_json(NEW)::TEXT);
        RETURN NEW;
        
    ELSIF (TG_OP = 'UPDATE') THEN
        -- Kontrola, či je jazda zamknutá
        IF OLD.period_locked = TRUE THEN
            -- Povoliť len zmenu status na LOCKED (admin unlock)
            IF NOT (OLD.status = NEW.status AND OLD.period_locked != NEW.period_locked) THEN
                RAISE EXCEPTION 'Jazda je zamknutá a nemôže byť upravená. Najprv odomknite obdobie.';
            END IF;
        END IF;
        
        -- Loguj status zmeny
        IF OLD.status != NEW.status THEN
            INSERT INTO trip_audit_log (trip_id, action, field_name, old_value, new_value, changed_by)
            VALUES (NEW.id, 'UPDATED', 'status', OLD.status, NEW.status, v_changed_by);
            
            -- Špeciálny log pre potvrdenie
            IF NEW.status = 'CONFIRMED' THEN
                INSERT INTO trip_audit_log (trip_id, action, changed_by)
                VALUES (NEW.id, 'CONFIRMED', v_changed_by);
            END IF;
        END IF;
        
        -- Loguj typ jazdy
        IF OLD.trip_type != NEW.trip_type THEN
            INSERT INTO trip_audit_log (trip_id, action, field_name, old_value, new_value, changed_by)
            VALUES (NEW.id, 'UPDATED', 'trip_type', OLD.trip_type, NEW.trip_type, v_changed_by);
        END IF;
        
        -- Loguj účel
        IF OLD.trip_purpose IS DISTINCT FROM NEW.trip_purpose THEN
            INSERT INTO trip_audit_log (trip_id, action, field_name, old_value, new_value, changed_by)
            VALUES (NEW.id, 'UPDATED', 'trip_purpose', OLD.trip_purpose, NEW.trip_purpose, v_changed_by);
        END IF;
        
        -- Loguj vodiča
        IF OLD.driver_id IS DISTINCT FROM NEW.driver_id THEN
            INSERT INTO trip_audit_log (trip_id, action, field_name, old_value, new_value, changed_by)
            VALUES (NEW.id, 'UPDATED', 'driver_id', OLD.driver_id::TEXT, NEW.driver_id::TEXT, v_changed_by);
        END IF;
        
        -- Loguj vzdialenosť (ručné úpravy)
        IF OLD.distance_meters != NEW.distance_meters THEN
            INSERT INTO trip_audit_log (trip_id, action, field_name, old_value, new_value, changed_by)
            VALUES (NEW.id, 'UPDATED', 'distance_meters', OLD.distance_meters::TEXT, NEW.distance_meters::TEXT, v_changed_by);
        END IF;
        
        RETURN NEW;
        
    ELSIF (TG_OP = 'DELETE') THEN
        IF OLD.period_locked = TRUE THEN
            RAISE EXCEPTION 'Nemôžete vymazať zamknutú jazdu';
        END IF;
        
        INSERT INTO trip_audit_log (trip_id, action, changed_by, old_value)
        VALUES (OLD.id, 'DELETED', v_changed_by, row_to_json(OLD)::TEXT);
        RETURN OLD;
    END IF;
    
    RETURN NULL;
END;
$$;


--
-- Name: prevent_audit_modification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_audit_modification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'Audit log je nemenný a nemôže byť upravený alebo vymazaný';
END;
$$;


--
-- Name: recalculate_odometers(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recalculate_odometers(p_vehicle_id integer DEFAULT NULL::integer) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    updated_count INTEGER := 0;
BEGIN
    WITH ordered_trips AS (
        SELECT t.id, t.vehicle_id, t.distance_meters,
               v.initial_odometer,
               SUM(t.distance_meters) OVER (
                   PARTITION BY t.vehicle_id 
                   ORDER BY t.start_time ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
               ) as cumulative_before,
               SUM(t.distance_meters) OVER (
                   PARTITION BY t.vehicle_id 
                   ORDER BY t.start_time ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) as cumulative_after
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.merged_into_id IS NULL
          AND (p_vehicle_id IS NULL OR t.vehicle_id = p_vehicle_id)
    )
    UPDATE trips
    SET start_odometer = ROUND((ot.initial_odometer * 1000 + COALESCE(ot.cumulative_before, 0)) / 1000.0, 1),
        end_odometer = ROUND((ot.initial_odometer * 1000 + ot.cumulative_after) / 1000.0, 1)
    FROM ordered_trips ot
    WHERE trips.id = ot.id;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;


--
-- Name: suggest_trip_classification(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.suggest_trip_classification(p_start_zone_id integer, p_end_zone_id integer) RETURNS TABLE(suggested_type character varying, suggested_purpose text, rule_name character varying)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        cr.suggested_trip_type,
        cr.suggested_purpose,
        cr.rule_name
    FROM classification_rules cr
    WHERE cr.active = TRUE
        AND (
            (cr.start_zone_id = p_start_zone_id AND cr.end_zone_id = p_end_zone_id) OR
            (cr.start_zone_id = p_start_zone_id AND cr.end_zone_id IS NULL) OR
            (cr.start_zone_id IS NULL AND cr.end_zone_id = p_end_zone_id)
        )
    ORDER BY cr.priority DESC
    LIMIT 1;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Try updated_at first (vehicles table), fallback to last_modified_at (trips table)
    IF TG_TABLE_NAME = 'trips' THEN
        NEW.last_modified_at = CURRENT_TIMESTAMP;
    ELSE
        NEW.updated_at = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: classification_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.classification_rules (
    id integer NOT NULL,
    rule_name character varying(100) NOT NULL,
    start_zone_id integer,
    end_zone_id integer,
    suggested_trip_type character varying(20) NOT NULL,
    suggested_purpose text,
    priority integer DEFAULT 0,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_trip_type CHECK (((suggested_trip_type)::text = ANY ((ARRAY['business'::character varying, 'private'::character varying, 'commute'::character varying])::text[])))
);


--
-- Name: classification_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.classification_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: classification_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.classification_rules_id_seq OWNED BY public.classification_rules.id;


--
-- Name: drivers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drivers (
    id integer NOT NULL,
    first_name character varying(50) NOT NULL,
    last_name character varying(50) NOT NULL,
    email character varying(100),
    phone character varying(20),
    license_number character varying(20),
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: drivers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drivers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drivers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drivers_id_seq OWNED BY public.drivers.id;


--
-- Name: export_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.export_history (
    id integer NOT NULL,
    export_type character varying(20) NOT NULL,
    format_version character varying(10) DEFAULT '1.0'::character varying,
    vehicle_id integer,
    driver_id integer,
    period_start date,
    period_end date,
    trip_type character varying(20),
    trips_count integer NOT NULL,
    file_path text,
    file_hash text,
    generated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    generated_by integer,
    ip_address inet,
    CONSTRAINT check_export_type CHECK (((export_type)::text = ANY ((ARRAY['PDF'::character varying, 'CSV'::character varying, 'EXCEL'::character varying, 'JSON'::character varying])::text[])))
);


--
-- Name: export_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.export_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: export_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.export_history_id_seq OWNED BY public.export_history.id;


--
-- Name: geofence_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geofence_zones (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    latitude numeric(10,8) NOT NULL,
    longitude numeric(11,8) NOT NULL,
    radius_meters integer DEFAULT 100 NOT NULL,
    zone_type character varying(50) NOT NULL,
    color character varying(7) DEFAULT '#3498db'::character varying,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_radius CHECK (((radius_meters > 0) AND (radius_meters <= 5000)))
);


--
-- Name: geofence_zones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.geofence_zones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: geofence_zones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.geofence_zones_id_seq OWNED BY public.geofence_zones.id;


--
-- Name: import_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_log (
    id integer NOT NULL,
    import_type character varying(50) NOT NULL,
    started_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp without time zone,
    status character varying(30) DEFAULT 'running'::character varying NOT NULL,
    records_processed integer DEFAULT 0,
    records_inserted integer DEFAULT 0,
    records_updated integer DEFAULT 0,
    errors integer DEFAULT 0,
    error_messages text
);


--
-- Name: import_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_log_id_seq OWNED BY public.import_log.id;


--
-- Name: trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trips (
    id integer NOT NULL,
    vehicle_id integer NOT NULL,
    driver_id integer,
    start_time timestamp without time zone NOT NULL,
    end_time timestamp without time zone,
    start_latitude numeric(10,8) NOT NULL,
    start_longitude numeric(11,8) NOT NULL,
    end_latitude numeric(10,8),
    end_longitude numeric(11,8),
    start_address character varying(500),
    end_address character varying(500),
    distance_meters numeric(10,2) DEFAULT 0 NOT NULL,
    duration_seconds integer,
    traccar_position_id_start bigint,
    traccar_position_id_end bigint,
    gps_route_reference text,
    start_odometer numeric(10,2),
    end_odometer numeric(10,2),
    start_zone_id integer,
    end_zone_id integer,
    trip_type character varying(20) DEFAULT 'unconfirmed'::character varying NOT NULL,
    trip_purpose text,
    status character varying(20) DEFAULT 'UNCONFIRMED'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    created_by integer,
    confirmed_at timestamp without time zone,
    confirmed_by integer,
    last_modified_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_modified_by integer,
    period_locked boolean DEFAULT false,
    locked_at timestamp without time zone,
    locked_by integer,
    internal_notes text,
    attachments jsonb,
    is_parking boolean DEFAULT false,
    merged_into_id integer,
    split_from_id integer,
    CONSTRAINT check_business_purpose CHECK ((((trip_type)::text <> 'business'::text) OR (((trip_type)::text = 'business'::text) AND (trip_purpose IS NOT NULL) AND (length(TRIM(BOTH FROM trip_purpose)) >= 3)))),
    CONSTRAINT check_distance CHECK ((distance_meters >= (0)::numeric)),
    CONSTRAINT check_end_time CHECK (((end_time IS NULL) OR (end_time >= start_time))),
    CONSTRAINT check_status CHECK (((status)::text = ANY ((ARRAY['UNCONFIRMED'::character varying, 'CONFIRMED'::character varying, 'LOCKED'::character varying])::text[]))),
    CONSTRAINT check_trip_type CHECK (((trip_type)::text = ANY ((ARRAY['business'::character varying, 'private'::character varying, 'commute'::character varying, 'unconfirmed'::character varying])::text[])))
);


--
-- Name: COLUMN trips.is_parking; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trips.is_parking IS 'Auto-detected parking/stop (GPS drift while stationary)';


--
-- Name: COLUMN trips.merged_into_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.trips.merged_into_id IS 'If set, this trip was superseded by a more complete version';


--
-- Name: monthly_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.monthly_summary AS
 SELECT date_trunc('month'::text, start_time) AS month,
    vehicle_id,
    trip_type,
    count(*) AS trips_count,
    (sum(distance_meters) / 1000.0) AS total_km,
    ((sum(duration_seconds))::numeric / 3600.0) AS total_hours,
    count(*) FILTER (WHERE ((status)::text = 'CONFIRMED'::text)) AS confirmed_trips,
    count(*) FILTER (WHERE ((status)::text = 'UNCONFIRMED'::text)) AS unconfirmed_trips
   FROM public.trips
  GROUP BY (date_trunc('month'::text, start_time)), vehicle_id, trip_type;


--
-- Name: period_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.period_locks (
    id integer NOT NULL,
    vehicle_id integer,
    period_start date NOT NULL,
    period_end date NOT NULL,
    locked_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    locked_by integer,
    lock_reason text,
    trips_count integer NOT NULL,
    business_trips_count integer,
    private_trips_count integer,
    total_distance_km numeric(10,2),
    hash_signature text,
    CONSTRAINT check_period CHECK ((period_end >= period_start))
);


--
-- Name: period_locks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.period_locks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: period_locks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.period_locks_id_seq OWNED BY public.period_locks.id;


--
-- Name: positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.positions (
    id bigint NOT NULL,
    traccar_id bigint,
    device_id integer,
    vehicle_id integer,
    latitude numeric(10,8) NOT NULL,
    longitude numeric(11,8) NOT NULL,
    altitude numeric(10,2),
    speed numeric(10,2),
    course numeric(10,2),
    address character varying(500),
    accuracy numeric(10,2),
    device_time timestamp without time zone,
    server_time timestamp without time zone,
    fix_time timestamp without time zone,
    attributes jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: positions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.positions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: positions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.positions_id_seq OWNED BY public.positions.id;


--
-- Name: saved_places; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_places (
    id integer NOT NULL,
    google_place_id character varying(255),
    name character varying(500) NOT NULL,
    address character varying(500),
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    place_type character varying(100),
    use_count integer DEFAULT 1,
    created_at timestamp without time zone DEFAULT now(),
    last_used_at timestamp without time zone DEFAULT now()
);


--
-- Name: saved_places_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.saved_places_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: saved_places_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.saved_places_id_seq OWNED BY public.saved_places.id;


--
-- Name: trip_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_audit_log (
    id bigint NOT NULL,
    trip_id integer NOT NULL,
    action character varying(20) NOT NULL,
    field_name character varying(100),
    old_value text,
    new_value text,
    changed_by integer,
    changed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip_address inet,
    user_agent text,
    CONSTRAINT check_action CHECK (((action)::text = ANY ((ARRAY['CREATED'::character varying, 'UPDATED'::character varying, 'CONFIRMED'::character varying, 'LOCKED'::character varying, 'UNLOCKED'::character varying, 'DELETED'::character varying])::text[])))
);


--
-- Name: trip_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trip_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trip_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trip_audit_log_id_seq OWNED BY public.trip_audit_log.id;


--
-- Name: vehicles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicles (
    id integer NOT NULL,
    traccar_device_id integer,
    name character varying(100) NOT NULL,
    registration_plate character varying(20),
    vin character varying(17),
    brand character varying(50),
    model character varying(50),
    year integer,
    fuel_type character varying(20),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    initial_odometer numeric(10,1) DEFAULT 0
);


--
-- Name: trips_detailed_view; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.trips_detailed_view AS
 SELECT t.id,
    t.vehicle_id,
    v.name AS vehicle_name,
    v.registration_plate,
    v.vin,
    t.driver_id,
    concat(d.first_name, ' ', d.last_name) AS driver_name,
    t.start_time,
    t.end_time,
    t.start_latitude,
    t.start_longitude,
    t.end_latitude,
    t.end_longitude,
    t.start_address,
    t.end_address,
    t.distance_meters,
    (t.distance_meters / 1000.0) AS distance_km,
    t.duration_seconds,
    (t.duration_seconds / 60) AS duration_minutes,
    t.start_odometer,
    t.end_odometer,
    t.trip_type,
    t.trip_purpose,
    t.status,
    t.start_zone_id,
    t.end_zone_id,
    sz.name AS start_zone_name,
    sz.zone_type AS start_zone_type,
    ez.name AS end_zone_name,
    ez.zone_type AS end_zone_type,
    t.period_locked,
    t.is_parking,
    t.merged_into_id,
    t.split_from_id,
    t.internal_notes,
    t.created_at,
    t.confirmed_at,
    t.confirmed_by,
    concat(cd.first_name, ' ', cd.last_name) AS confirmed_by_name,
    t.last_modified_at,
    t.last_modified_by
   FROM (((((public.trips t
     LEFT JOIN public.vehicles v ON ((t.vehicle_id = v.id)))
     LEFT JOIN public.drivers d ON ((t.driver_id = d.id)))
     LEFT JOIN public.geofence_zones sz ON ((t.start_zone_id = sz.id)))
     LEFT JOIN public.geofence_zones ez ON ((t.end_zone_id = ez.id)))
     LEFT JOIN public.drivers cd ON ((t.confirmed_by = cd.id)));


--
-- Name: trips_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trips_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trips_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trips_id_seq OWNED BY public.trips.id;


--
-- Name: vehicle_devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vehicle_devices (
    id integer NOT NULL,
    vehicle_id integer NOT NULL,
    traccar_device_id integer NOT NULL,
    device_name character varying(255),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: vehicle_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicle_devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicle_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicle_devices_id_seq OWNED BY public.vehicle_devices.id;


--
-- Name: vehicles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vehicles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vehicles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vehicles_id_seq OWNED BY public.vehicles.id;


--
-- Name: classification_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules ALTER COLUMN id SET DEFAULT nextval('public.classification_rules_id_seq'::regclass);


--
-- Name: drivers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers ALTER COLUMN id SET DEFAULT nextval('public.drivers_id_seq'::regclass);


--
-- Name: export_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_history ALTER COLUMN id SET DEFAULT nextval('public.export_history_id_seq'::regclass);


--
-- Name: geofence_zones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_zones ALTER COLUMN id SET DEFAULT nextval('public.geofence_zones_id_seq'::regclass);


--
-- Name: import_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_log ALTER COLUMN id SET DEFAULT nextval('public.import_log_id_seq'::regclass);


--
-- Name: period_locks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks ALTER COLUMN id SET DEFAULT nextval('public.period_locks_id_seq'::regclass);


--
-- Name: positions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions ALTER COLUMN id SET DEFAULT nextval('public.positions_id_seq'::regclass);


--
-- Name: saved_places id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_places ALTER COLUMN id SET DEFAULT nextval('public.saved_places_id_seq'::regclass);


--
-- Name: trip_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_audit_log ALTER COLUMN id SET DEFAULT nextval('public.trip_audit_log_id_seq'::regclass);


--
-- Name: trips id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips ALTER COLUMN id SET DEFAULT nextval('public.trips_id_seq'::regclass);


--
-- Name: vehicle_devices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_devices ALTER COLUMN id SET DEFAULT nextval('public.vehicle_devices_id_seq'::regclass);


--
-- Name: vehicles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles ALTER COLUMN id SET DEFAULT nextval('public.vehicles_id_seq'::regclass);


--
-- Name: classification_rules classification_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_pkey PRIMARY KEY (id);


--
-- Name: drivers drivers_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_email_key UNIQUE (email);


--
-- Name: drivers drivers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drivers
    ADD CONSTRAINT drivers_pkey PRIMARY KEY (id);


--
-- Name: export_history export_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_history
    ADD CONSTRAINT export_history_pkey PRIMARY KEY (id);


--
-- Name: geofence_zones geofence_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_zones
    ADD CONSTRAINT geofence_zones_pkey PRIMARY KEY (id);


--
-- Name: import_log import_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_log
    ADD CONSTRAINT import_log_pkey PRIMARY KEY (id);


--
-- Name: period_locks period_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_pkey PRIMARY KEY (id);


--
-- Name: positions positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_pkey PRIMARY KEY (id);


--
-- Name: positions positions_traccar_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_traccar_id_key UNIQUE (traccar_id);


--
-- Name: saved_places saved_places_google_place_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_places
    ADD CONSTRAINT saved_places_google_place_id_key UNIQUE (google_place_id);


--
-- Name: saved_places saved_places_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_places
    ADD CONSTRAINT saved_places_pkey PRIMARY KEY (id);


--
-- Name: trip_audit_log trip_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_audit_log
    ADD CONSTRAINT trip_audit_log_pkey PRIMARY KEY (id);


--
-- Name: trips trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (id);


--
-- Name: vehicle_devices vehicle_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_devices
    ADD CONSTRAINT vehicle_devices_pkey PRIMARY KEY (id);


--
-- Name: vehicle_devices vehicle_devices_vehicle_id_traccar_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_devices
    ADD CONSTRAINT vehicle_devices_vehicle_id_traccar_device_id_key UNIQUE (vehicle_id, traccar_device_id);


--
-- Name: vehicles vehicles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_pkey PRIMARY KEY (id);


--
-- Name: vehicles vehicles_traccar_device_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicles
    ADD CONSTRAINT vehicles_traccar_device_id_key UNIQUE (traccar_device_id);


--
-- Name: idx_audit_changed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_changed_at ON public.trip_audit_log USING btree (changed_at DESC);


--
-- Name: idx_audit_changed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_changed_by ON public.trip_audit_log USING btree (changed_by);


--
-- Name: idx_audit_trip_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_trip_id ON public.trip_audit_log USING btree (trip_id);


--
-- Name: idx_classification_rules_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_classification_rules_active ON public.classification_rules USING btree (active);


--
-- Name: idx_classification_rules_zones; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_classification_rules_zones ON public.classification_rules USING btree (start_zone_id, end_zone_id);


--
-- Name: idx_export_history_generated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_export_history_generated_at ON public.export_history USING btree (generated_at DESC);


--
-- Name: idx_export_history_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_export_history_vehicle ON public.export_history USING btree (vehicle_id);


--
-- Name: idx_geofence_zones_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geofence_zones_active ON public.geofence_zones USING btree (active);


--
-- Name: idx_geofence_zones_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_geofence_zones_type ON public.geofence_zones USING btree (zone_type);


--
-- Name: idx_import_log_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_log_started_at ON public.import_log USING btree (started_at DESC);


--
-- Name: idx_period_locks_dates; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_period_locks_dates ON public.period_locks USING btree (period_start, period_end);


--
-- Name: idx_period_locks_vehicle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_period_locks_vehicle ON public.period_locks USING btree (vehicle_id);


--
-- Name: idx_positions_device_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_positions_device_time ON public.positions USING btree (device_time);


--
-- Name: idx_positions_traccar_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_positions_traccar_id ON public.positions USING btree (traccar_id);


--
-- Name: idx_positions_vehicle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_positions_vehicle_id ON public.positions USING btree (vehicle_id);


--
-- Name: idx_saved_places_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_saved_places_name ON public.saved_places USING btree (name);


--
-- Name: idx_trips_driver_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_driver_id ON public.trips USING btree (driver_id);


--
-- Name: idx_trips_driver_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_driver_status_time ON public.trips USING btree (driver_id, status, start_time DESC);


--
-- Name: idx_trips_end_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_end_time ON public.trips USING btree (end_time);


--
-- Name: idx_trips_end_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_end_zone ON public.trips USING btree (end_zone_id);


--
-- Name: idx_trips_merged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_merged ON public.trips USING btree (merged_into_id) WHERE (merged_into_id IS NOT NULL);


--
-- Name: idx_trips_period_locked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_period_locked ON public.trips USING btree (period_locked);


--
-- Name: idx_trips_split_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_split_from ON public.trips USING btree (split_from_id) WHERE (split_from_id IS NOT NULL);


--
-- Name: idx_trips_start_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_start_time ON public.trips USING btree (start_time);


--
-- Name: idx_trips_start_zone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_start_zone ON public.trips USING btree (start_zone_id);


--
-- Name: idx_trips_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_status ON public.trips USING btree (status);


--
-- Name: idx_trips_traccar_positions; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_trips_traccar_positions ON public.trips USING btree (traccar_position_id_start, traccar_position_id_end) WHERE ((traccar_position_id_start IS NOT NULL) AND (traccar_position_id_end IS NOT NULL));


--
-- Name: idx_trips_trip_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_trip_type ON public.trips USING btree (trip_type);


--
-- Name: idx_trips_vehicle_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_vehicle_id ON public.trips USING btree (vehicle_id);


--
-- Name: idx_trips_vehicle_status_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trips_vehicle_status_time ON public.trips USING btree (vehicle_id, status, start_time DESC);


--
-- Name: trip_audit_log prevent_audit_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_audit_delete BEFORE DELETE ON public.trip_audit_log FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_modification();


--
-- Name: trip_audit_log prevent_audit_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER prevent_audit_update BEFORE UPDATE ON public.trip_audit_log FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_modification();


--
-- Name: trips trip_audit_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trip_audit_trigger AFTER INSERT OR DELETE OR UPDATE ON public.trips FOR EACH ROW EXECUTE FUNCTION public.log_trip_changes();


--
-- Name: classification_rules update_classification_rules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_classification_rules_updated_at BEFORE UPDATE ON public.classification_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: drivers update_drivers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_drivers_updated_at BEFORE UPDATE ON public.drivers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: geofence_zones update_geofence_zones_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_geofence_zones_updated_at BEFORE UPDATE ON public.geofence_zones FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: trips update_trips_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_trips_updated_at BEFORE UPDATE ON public.trips FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: vehicles update_vehicles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_vehicles_updated_at BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: classification_rules classification_rules_end_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_end_zone_id_fkey FOREIGN KEY (end_zone_id) REFERENCES public.geofence_zones(id) ON DELETE CASCADE;


--
-- Name: classification_rules classification_rules_start_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.classification_rules
    ADD CONSTRAINT classification_rules_start_zone_id_fkey FOREIGN KEY (start_zone_id) REFERENCES public.geofence_zones(id) ON DELETE CASCADE;


--
-- Name: export_history export_history_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_history
    ADD CONSTRAINT export_history_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: export_history export_history_generated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_history
    ADD CONSTRAINT export_history_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES public.drivers(id);


--
-- Name: export_history export_history_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_history
    ADD CONSTRAINT export_history_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE SET NULL;


--
-- Name: geofence_zones geofence_zones_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geofence_zones
    ADD CONSTRAINT geofence_zones_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.drivers(id);


--
-- Name: period_locks period_locks_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.drivers(id);


--
-- Name: period_locks period_locks_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.period_locks
    ADD CONSTRAINT period_locks_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE CASCADE;


--
-- Name: positions positions_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE SET NULL;


--
-- Name: trip_audit_log trip_audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_audit_log
    ADD CONSTRAINT trip_audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: trip_audit_log trip_audit_log_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_audit_log
    ADD CONSTRAINT trip_audit_log_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: trips trips_confirmed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_confirmed_by_fkey FOREIGN KEY (confirmed_by) REFERENCES public.drivers(id);


--
-- Name: trips trips_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.drivers(id);


--
-- Name: trips trips_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;


--
-- Name: trips trips_end_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_end_zone_id_fkey FOREIGN KEY (end_zone_id) REFERENCES public.geofence_zones(id) ON DELETE SET NULL;


--
-- Name: trips trips_last_modified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_last_modified_by_fkey FOREIGN KEY (last_modified_by) REFERENCES public.drivers(id);


--
-- Name: trips trips_locked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES public.drivers(id);


--
-- Name: trips trips_merged_into_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_merged_into_id_fkey FOREIGN KEY (merged_into_id) REFERENCES public.trips(id);


--
-- Name: trips trips_split_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_split_from_id_fkey FOREIGN KEY (split_from_id) REFERENCES public.trips(id);


--
-- Name: trips trips_start_zone_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_start_zone_id_fkey FOREIGN KEY (start_zone_id) REFERENCES public.geofence_zones(id) ON DELETE SET NULL;


--
-- Name: trips trips_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE RESTRICT;


--
-- Name: vehicle_devices vehicle_devices_vehicle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vehicle_devices
    ADD CONSTRAINT vehicle_devices_vehicle_id_fkey FOREIGN KEY (vehicle_id) REFERENCES public.vehicles(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


