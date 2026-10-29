<?php
// One-time installer: creates the database, tables and your first admin.
require __DIR__ . '/config.php';

function h($s) { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

$lock = __DIR__ . '/installed.lock';
$done = false; $error = ''; $warn = '';
$name = 'Main admin'; $email = '';

$problems = [];
if (version_compare(PHP_VERSION, '7.4.0', '<')) $problems[] = 'PHP 7.4 or newer is required. Your version is ' . PHP_VERSION . '.';
if (!extension_loaded('pdo_mysql')) $problems[] = 'The pdo_mysql PHP extension is off. In XAMPP, open php.ini and remove the ";" before extension=pdo_mysql, then restart Apache.';

$locked = file_exists($lock);

if (!$locked && !$problems && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $name  = trim((string)($_POST['name'] ?? '')) ?: 'Main admin';
    $email = strtolower(trim((string)($_POST['email'] ?? '')));
    $pass  = (string)($_POST['password'] ?? '');

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        $error = 'Enter a valid email address.';
    } elseif (strlen($pass) < 8) {
        $error = 'Password needs at least 8 characters.';
    } else {
        try {
            $pdo = new PDO('mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';charset=utf8mb4', DB_USER, DB_PASS,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $dbn = str_replace('`', '', DB_NAME);
            $pdo->exec("CREATE DATABASE IF NOT EXISTS `$dbn` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
            $pdo->exec("USE `$dbn`");

            $pdo->exec("CREATE TABLE IF NOT EXISTS admins (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(190) NOT NULL UNIQUE,
                name VARCHAR(60) NOT NULL,
                ngl_link VARCHAR(500) NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at INT UNSIGNED NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $pdo->exec("CREATE TABLE IF NOT EXISTS members (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                email VARCHAR(190) NOT NULL UNIQUE,
                name VARCHAR(60) NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                created_at INT UNSIGNED NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $pdo->exec("CREATE TABLE IF NOT EXISTS posts (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                body TEXT NOT NULL,
                photo VARCHAR(100) NULL,
                admin_id INT UNSIGNED NULL,
                created_at BIGINT UNSIGNED NOT NULL,
                KEY idx_posts_admin (admin_id),
                CONSTRAINT fk_posts_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $pdo->exec("CREATE TABLE IF NOT EXISTS comments (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                post_id INT UNSIGNED NOT NULL,
                body TEXT NOT NULL,
                created_at BIGINT UNSIGNED NOT NULL,
                KEY idx_comments_post (post_id, id),
                CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $pdo->exec("CREATE TABLE IF NOT EXISTS reactions (
                post_id INT UNSIGNED NOT NULL,
                voter VARCHAR(64) NOT NULL,
                kind TINYINT UNSIGNED NOT NULL,
                PRIMARY KEY (post_id, voter),
                CONSTRAINT fk_reactions_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $pdo->exec("CREATE TABLE IF NOT EXISTS settings (
                k VARCHAR(50) NOT NULL PRIMARY KEY,
                v VARCHAR(500) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
            $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
                id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                ip VARCHAR(45) NOT NULL,
                created_at INT UNSIGNED NOT NULL,
                KEY idx_ip (ip)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

            $s = $pdo->prepare('SELECT id FROM admins WHERE email = ?');
            $s->execute([$email]);
            if ($s->fetch()) {
                $pdo->prepare('UPDATE admins SET name = ?, password_hash = ? WHERE email = ?')
                    ->execute([mb_substr($name, 0, 60, 'UTF-8'), password_hash($pass, PASSWORD_DEFAULT), $email]);
            } else {
                $pdo->prepare('INSERT INTO admins (email, name, password_hash, created_at) VALUES (?,?,?,?)')
                    ->execute([$email, mb_substr($name, 0, 60, 'UTF-8'), password_hash($pass, PASSWORD_DEFAULT), time()]);
            }
            if (@file_put_contents($lock, date('c')) === false) {
                $warn = 'Installed, but the installer could not lock itself. Delete install.php manually.';
            }
            $done = true;
        } catch (Throwable $e) {
            $code = (int)$e->getCode();
            if ($code === 2002 || stripos($e->getMessage(), 'actively refused') !== false || stripos($e->getMessage(), 'Connection refused') !== false) {
                $error = 'Cannot reach MySQL. Open the XAMPP Control Panel and click Start next to MySQL, then try again.';
            } elseif ($code === 1045) {
                $error = 'MySQL refused the login. Check DB_USER and DB_PASS in config.php (XAMPP default: root with an empty password).';
            } else {
                $error = 'Database error: ' . $e->getMessage();
            }
        }
    }
}
?><!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install NGL MB Confessions</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;background:#f6f7fb;color:#1d1d2b;margin:0;padding:24px}
.box{max-width:440px;margin:30px auto;background:#fff;border:2px solid #e6e6ef;border-radius:18px;padding:26px}
h1{margin:0 0 6px;font-size:1.4rem}p{color:#555}label{display:block;font-weight:600;margin:14px 0 5px;font-size:.92rem}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:2px solid #e6e6ef;border-radius:12px;font:inherit}
button,.btn{margin-top:18px;background:#ff3333;color:#fff;border:0;border-radius:999px;padding:11px 22px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
.err{background:#ffe9e9;color:#a40000;padding:10px 12px;border-radius:10px;margin-top:14px}
.ok{background:#e6f8df;color:#1f5a0c;padding:10px 12px;border-radius:10px;margin-top:14px}
</style></head><body><div class="box">
<h1>NGL MB Confessions setup</h1>
<?php if ($problems): ?>
  <?php foreach ($problems as $p): ?><div class="err"><?= h($p) ?></div><?php endforeach; ?>
<?php elseif ($locked && !$done): ?>
  <div class="ok">Already installed. For safety, delete <b>install.php</b> from the backend folder.</div>
  <a class="btn" href="../frontend/">Open the website</a>
<?php elseif ($done): ?>
  <div class="ok">Done. Database <b><?= h(DB_NAME) ?></b> and your admin account are ready.</div>
  <?php if ($warn): ?><div class="err"><?= h($warn) ?></div><?php endif; ?>
  <p>Next, delete <b>install.php</b> from the backend folder, then log in on the website with <b><?= h($email) ?></b>.</p>
  <a class="btn" href="../frontend/">Open the website</a>
<?php else: ?>
  <p>This creates the database <b><?= h(DB_NAME) ?></b>, its tables, and your first admin account. Make sure MySQL is running in XAMPP.</p>
  <?php if ($error): ?><div class="err"><?= h($error) ?></div><?php endif; ?>
  <form method="post">
    <label for="name">Admin name</label><input id="name" name="name" value="<?= h($name) ?>" maxlength="60">
    <label for="email">Admin email</label><input id="email" name="email" type="email" value="<?= h($email) ?>" required>
    <label for="password">Admin password (8+ characters)</label><input id="password" name="password" type="password" minlength="8" required>
    <button type="submit">Create database and admin</button>
  </form>
<?php endif; ?>
</div></body></html>
