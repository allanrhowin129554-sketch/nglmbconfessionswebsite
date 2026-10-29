-- NGL MB Confessions database for XAMPP (MySQL / MariaDB)
-- Optional: you can skip this file and use backend/install.php instead.
-- phpMyAdmin: open http://localhost/phpmyadmin, click "Import", choose this file, click "Import".

CREATE DATABASE IF NOT EXISTS ngl_mb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ngl_mb;

CREATE TABLE IF NOT EXISTS admins (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  name VARCHAR(60) NOT NULL,
  ngl_link VARCHAR(500) NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS members (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  name VARCHAR(60) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at INT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS posts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  body TEXT NOT NULL,
  photo VARCHAR(100) NULL,
  created_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  post_id INT UNSIGNED NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  KEY idx_comments_post (post_id, id),
  CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reactions (
  post_id INT UNSIGNED NOT NULL,
  voter VARCHAR(64) NOT NULL,
  kind TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (post_id, voter),
  CONSTRAINT fk_reactions_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(50) NOT NULL PRIMARY KEY,
  v VARCHAR(500) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(45) NOT NULL,
  created_at INT UNSIGNED NOT NULL,
  KEY idx_ip (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Default admin: admin@nglmb.com / Admin@12345
-- Log in, add your own admin in the Admins section, then remove this one.
INSERT IGNORE INTO admins (email, name, password_hash, created_at)
VALUES ('admin@nglmb.com', 'Main admin', '$2b$10$QXZHi73jrtqQb16EZS3REOG78oozBfKI4HkzgpRe.Pr6H1b/AEXMi', UNIX_TIMESTAMP());
