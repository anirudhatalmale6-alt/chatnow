-- Schéma ChatNow. Rejouable : chaque objet est créé « IF NOT EXISTS », le
-- fichier peut donc être relancé sur une base déjà en service sans rien casser.

CREATE TABLE IF NOT EXISTS rooms (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug          VARCHAR(60)  NOT NULL,
  name          VARCHAR(80)  NOT NULL,
  description   VARCHAR(190) NULL,
  emoji         VARCHAR(12)  NULL,
  min_age       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  position      INT NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_room_slug (slug),
  KEY idx_room_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Un « visiteur » n'est pas un compte : c'est une session anonyme. On garde le
-- strict nécessaire pour la modération (empreinte d'IP, jamais l'IP en clair).
CREATE TABLE IF NOT EXISTS visitors (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  uid           CHAR(32)     NOT NULL,
  pseudo        VARCHAR(24)  NOT NULL,
  age           TINYINT UNSIGNED NULL,
  gender        ENUM('h','f','a') NOT NULL DEFAULT 'a',
  region        VARCHAR(60)  NULL,
  avatar_color  VARCHAR(7)   NOT NULL DEFAULT '#2563eb',
  role          ENUM('user','moderator','admin') NOT NULL DEFAULT 'user',
  ip_hash       CHAR(64)     NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at  DATETIME NULL,
  UNIQUE KEY uq_visitor_uid (uid),
  KEY idx_visitor_pseudo (pseudo),
  KEY idx_visitor_ip (ip_hash),
  KEY idx_visitor_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_id       INT UNSIGNED NOT NULL,
  visitor_id    BIGINT UNSIGNED NULL,
  pseudo        VARCHAR(24)  NOT NULL,
  avatar_color  VARCHAR(7)   NOT NULL DEFAULT '#2563eb',
  body          VARCHAR(1000) NOT NULL,
  kind          ENUM('user','system') NOT NULL DEFAULT 'user',
  ip_hash       CHAR(64)     NULL,
  created_at    DATETIME NOT NULL,
  KEY idx_msg_room (room_id, id),
  KEY idx_msg_created (created_at),
  KEY idx_msg_visitor (visitor_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Messages privés : conservés le temps de la rétention, pour pouvoir traiter un
-- signalement. Jamais affichés à un tiers en dehors du panneau de modération.
CREATE TABLE IF NOT EXISTS private_messages (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_uid      CHAR(32)     NOT NULL,
  to_uid        CHAR(32)     NOT NULL,
  from_pseudo   VARCHAR(24)  NOT NULL,
  body          VARCHAR(1000) NOT NULL,
  is_read       TINYINT(1) NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL,
  KEY idx_pm_pair (to_uid, from_uid, id),
  KEY idx_pm_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Filtre de contenu. « action » : block = message refusé, mask = mot remplacé
-- par des étoiles. Modifiable depuis le panneau d'administration.
CREATE TABLE IF NOT EXISTS banned_words (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  word          VARCHAR(80) NOT NULL,
  action        ENUM('block','mask') NOT NULL DEFAULT 'mask',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_word (word)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bans (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  scope         ENUM('ip','pseudo') NOT NULL,
  value         VARCHAR(64) NOT NULL,
  reason        VARCHAR(190) NULL,
  expires_at    DATETIME NULL,
  created_by    VARCHAR(24) NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ban (scope, value),
  KEY idx_ban_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reports (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id    BIGINT UNSIGNED NULL,
  target_pseudo VARCHAR(24) NOT NULL,
  target_uid    CHAR(32) NULL,
  reporter_uid  CHAR(32) NULL,
  reporter_pseudo VARCHAR(24) NULL,
  context       VARCHAR(1000) NULL,
  reason        VARCHAR(190) NULL,
  status        ENUM('open','done') NOT NULL DEFAULT 'open',
  created_at    DATETIME NOT NULL,
  KEY idx_report_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Journal de modération : ce que le filtre a refusé. Sert à régler la liste de
-- mots sans avoir à deviner (on voit ce qui est bloqué, et à tort ou à raison).
CREATE TABLE IF NOT EXISTS moderation_log (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  pseudo        VARCHAR(24) NOT NULL,
  ip_hash       CHAR(64) NULL,
  rule          VARCHAR(40) NOT NULL,
  body          VARCHAR(1000) NULL,
  created_at    DATETIME NOT NULL,
  KEY idx_modlog_created (created_at),
  KEY idx_modlog_rule (rule)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
