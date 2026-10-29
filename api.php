<?php
require __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function out($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function fail($msg, $code = 400) { out(['error' => $msg], $code); }

ini_set('session.gc_maxlifetime', '604800');
session_name('nglmb');
session_set_cookie_params([
    'lifetime' => 604800,
    'path'     => '/',
    'httponly' => true,
    'samesite' => 'Lax',
    'secure'   => !empty($_SERVER['HTTPS']),
]);
session_start();

$action = isset($_GET['action']) ? (string)$_GET['action'] : '';
$method = $_SERVER['REQUEST_METHOD'];
$in = [];

if ($method === 'POST') {
    // This header can't be sent by a plain cross-site form, which blocks CSRF.
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'fetch') fail('Bad request.');
    $raw = file_get_contents('php://input');
    if (strlen($raw) > 4500000) fail('Request too large. Images must be under 3 MB.', 413);
    $decoded = json_decode($raw, true);
    $in = is_array($decoded) ? $decoded : [];
}

$voter = $_SERVER['HTTP_X_VOTER'] ?? '';
$voterOk = (bool)preg_match('/^[A-Za-z0-9-]{16,64}$/', $voter);

function current_admin() {
    if (empty($_SESSION['aid'])) return null;
    $s = db()->prepare('SELECT id, email, name, ngl_link FROM admins WHERE id = ?');
    $s->execute([$_SESSION['aid']]);
    $a = $s->fetch();
    if (!$a) { unset($_SESSION['aid']); return null; }   // admin was removed
    return ['id' => (int)$a['id'], 'email' => $a['email'], 'name' => $a['name'], 'ngl' => $a['ngl_link'] ?? ''];
}
function current_member() {
    if (empty($_SESSION['mid'])) return null;
    $s = db()->prepare('SELECT id, email, name, password_hash FROM members WHERE id = ?');
    $s->execute([$_SESSION['mid']]);
    $member = $s->fetch();
    if (!$member || !isset($_SESSION['member_password_hash']) || !hash_equals($member['password_hash'], $_SESSION['member_password_hash'])) {
        unset($_SESSION['mid'], $_SESSION['member_password_hash']);
        return null;
    }
    return ['id' => (int)$member['id'], 'email' => $member['email'], 'name' => $member['name']];
}
function need_admin() {
    $a = current_admin();
    if (!$a) fail('Log in as admin first.', 401);
    return $a;
}
function need_post($method) { if ($method !== 'POST') fail('Use POST for this action.', 405); }
function parse_photo($value) {
    if ($value === null || $value === '') return null;
    if (!is_string($value) || !preg_match('#^data:image/(jpeg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$#', $value, $m))
        fail('Choose a valid JPG, PNG, GIF, or WebP image under 3 MB.');
    $bytes = base64_decode($m[2], true);
    if ($bytes === false || strlen($bytes) > 3 * 1024 * 1024)
        fail('Choose a valid JPG, PNG, GIF, or WebP image under 3 MB.');
    $image = @getimagesizefromstring($bytes);
    $mimeByType = ['jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp', 'gif' => 'image/gif'];
    if (!$image || !isset($mimeByType[$m[1]]) || $image['mime'] !== $mimeByType[$m[1]])
        fail('The selected file is not a valid supported image.');
    $extension = ['jpeg' => 'jpg', 'png' => 'png', 'webp' => 'webp', 'gif' => 'gif'][$m[1]];
    $directory = __DIR__ . '/../frontend/uploads';
    if (!is_dir($directory) && !@mkdir($directory, 0775, true) && !is_dir($directory))
        fail('Could not create the photo uploads folder.', 500);
    $filename = bin2hex(random_bytes(16)) . '.' . $extension;
    if (@file_put_contents($directory . '/' . $filename, $bytes, LOCK_EX) === false)
        fail('Could not save the selected photo.', 500);
    return 'uploads/' . $filename;
}
function remove_photo($photo) {
    if (!is_string($photo) || !preg_match('#^uploads/[a-f0-9]{32}\.(jpg|png|webp|gif)$#', $photo)) return;
    $path = __DIR__ . '/../frontend/' . $photo;
    if (is_file($path) && !unlink($path)) error_log('NGL MB: Could not remove confession photo ' . basename($path));
}

try {
    $pdo = db();
    $pdo->exec("CREATE TABLE IF NOT EXISTS members (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(190) NOT NULL UNIQUE,
        name VARCHAR(60) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS member_password_resets (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        member_id INT UNSIGNED NOT NULL,
        expires_at INT UNSIGNED NOT NULL,
        created_at INT UNSIGNED NOT NULL,
        KEY idx_member_password_resets_member (member_id),
        CONSTRAINT fk_member_password_resets_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $pdo->exec("CREATE TABLE IF NOT EXISTS password_reset_attempts (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(45) NOT NULL,
        created_at INT UNSIGNED NOT NULL,
        KEY idx_password_reset_attempts_ip_time (ip, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $nglColumn = $pdo->query("SHOW COLUMNS FROM admins LIKE 'ngl_link'")->fetch();
    if (!$nglColumn) {
        $pdo->exec('ALTER TABLE admins ADD ngl_link VARCHAR(500) NULL');
        $legacyLink = $pdo->query("SELECT v FROM settings WHERE k = 'ngl_link'")->fetch();
        if ($legacyLink && $legacyLink['v'] !== '') {
            $pdo->prepare('UPDATE admins SET ngl_link = ? WHERE id = (SELECT id FROM (SELECT id FROM admins ORDER BY id LIMIT 1) AS first_admin) AND (ngl_link IS NULL OR ngl_link = \'\')')
                ->execute([$legacyLink['v']]);
        }
    }
    $photoColumn = $pdo->query("SHOW COLUMNS FROM posts LIKE 'photo'")->fetch();
    if (!$photoColumn) $pdo->exec('ALTER TABLE posts ADD photo VARCHAR(100) NULL');
    $adminIdColumn = $pdo->query("SHOW COLUMNS FROM posts LIKE 'admin_id'")->fetch();
    if (!$adminIdColumn) $pdo->exec('ALTER TABLE posts ADD admin_id INT UNSIGNED NULL AFTER photo');
    $pdo->exec("CREATE TABLE IF NOT EXISTS comments (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        post_id INT UNSIGNED NOT NULL,
        body TEXT NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        KEY idx_comments_post (post_id, id),
        CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

    switch ($action) {

    /* ---------- Public ---------- */
    case 'settings':
        $rows = db()->query('SELECT name, ngl_link AS ngl FROM admins ORDER BY id')->fetchAll();
        $links = array_values(array_filter($rows, static fn($a) => !empty($a['ngl'])));
        out(['ngl' => $links[0]['ngl'] ?? '', 'admins' => $links]);

    case 'posts':
        $posts  = db()->query('SELECT p.id, p.body, p.photo, p.created_at, p.admin_id, a.name AS admin_name FROM posts p LEFT JOIN admins a ON a.id = p.admin_id ORDER BY p.id DESC LIMIT 200')->fetchAll();
        $counts = db()->query('SELECT post_id, kind, COUNT(*) AS c FROM reactions GROUP BY post_id, kind')->fetchAll();
        $rmap = [];
        foreach ($counts as $c) {
            $pid = (int)$c['post_id'];
            if (!isset($rmap[$pid])) $rmap[$pid] = [0, 0, 0, 0, 0, 0];
            $rmap[$pid][(int)$c['kind']] = (int)$c['c'];
        }
        $mine = [];
        if ($voterOk) {
            $s = db()->prepare('SELECT post_id, kind FROM reactions WHERE voter = ?');
            $s->execute([$voter]);
            foreach ($s->fetchAll() as $m) $mine[(int)$m['post_id']] = (int)$m['kind'];
        }
        $postIds = array_map(static fn($p) => (int)$p['id'], $posts);
        $commentMap = [];
        if ($postIds) {
            $marks = implode(',', array_fill(0, count($postIds), '?'));
            $s = db()->prepare("SELECT id, post_id, body, created_at FROM comments WHERE post_id IN ($marks) ORDER BY id");
            $s->execute($postIds);
            foreach ($s->fetchAll() as $comment) {
                $pid = (int)$comment['post_id'];
                $commentMap[$pid][] = [
                    'id' => (int)$comment['id'],
                    'text' => $comment['body'],
                    't' => (int)$comment['created_at'],
                ];
            }
        }
        $list = [];
        foreach ($posts as $p) {
            $id = (int)$p['id'];
            $adminId = isset($p['admin_id']) && $p['admin_id'] !== null ? (int)$p['admin_id'] : null;
            $adminName = $adminId !== null ? ($p['admin_name'] ?: 'Admin') : 'Admin';
            $list[] = [
                'id'   => $id,
                'text' => $p['body'],
                'photo' => $p['photo'],
                't'    => (int)$p['created_at'],
                'posted_by' => $adminName,
                'admin_name' => $adminName,
                'admin' => $adminId !== null ? ['id' => $adminId, 'name' => $adminName] : null,
                'comments' => $commentMap[$id] ?? [],
                'r'    => $rmap[$id] ?? [0, 0, 0, 0, 0, 0],
                'mine' => array_key_exists($id, $mine) ? $mine[$id] : null,
            ];
        }
        out($list);

    case 'comment_add':
        need_post($method);
        if (isset($_SESSION['comment_at']) && time() - (int)$_SESSION['comment_at'] < 3)
            fail('Please wait a few seconds before commenting again.', 429);
        $id = (int)($in['id'] ?? 0);
        $text = trim((string)($in['text'] ?? ''));
        if ($text === '') fail('Write a comment first.');
        if (mb_strlen($text, 'UTF-8') > 1000) fail('Keep comments under 1000 characters.');
        $s = db()->prepare('SELECT 1 FROM posts WHERE id = ?');
        $s->execute([$id]);
        if (!$s->fetch()) fail('Confession not found.', 404);
        db()->prepare('INSERT INTO comments (post_id, body, created_at) VALUES (?,?,?)')
            ->execute([$id, $text, (int)round(microtime(true) * 1000)]);
        $_SESSION['comment_at'] = time();
        out(['ok' => true], 201);

    case 'react':
        need_post($method);
        if (!$voterOk) fail('Missing voter id. Reload the page.');
        $id = (int)($in['id'] ?? 0);
        $kind = $in['kind'] ?? null;
        $s = db()->prepare('SELECT 1 FROM posts WHERE id = ?');
        $s->execute([$id]);
        if (!$s->fetch()) fail('Confession not found.', 404);
        if ($kind === null) {
            db()->prepare('DELETE FROM reactions WHERE post_id = ? AND voter = ?')->execute([$id, $voter]);
        } elseif (is_int($kind) && $kind >= 0 && $kind <= 5) {
            db()->prepare('INSERT INTO reactions (post_id, voter, kind) VALUES (?,?,?)
                           ON DUPLICATE KEY UPDATE kind = VALUES(kind)')->execute([$id, $voter, $kind]);
        } else {
            fail('Invalid reaction.');
        }
        out(['ok' => true]);

    /* ---------- Login ---------- */
    case 'account_me':
        out(['member' => current_member()]);

    case 'account_register':
        need_post($method);
        $ip = substr($_SERVER['REMOTE_ADDR'] ?? '', 0, 45);
        db()->prepare('DELETE FROM login_attempts WHERE created_at < ?')->execute([time() - 900]);
        $s = db()->prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?');
        $s->execute([$ip]);
        if ((int)$s->fetch()['n'] >= 10) fail('Too many attempts. Wait 15 minutes and try again.', 429);

        $name = trim((string)($in['name'] ?? ''));
        $email = strtolower(trim((string)($in['email'] ?? '')));
        $pass = (string)($in['password'] ?? '');
        if ($name === '') fail('Enter your name.');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190) fail('Enter a valid email address.');
        if (strlen($pass) < 8 || strlen($pass) > 72) fail('Password must be 8 to 72 characters long.');
        $s = db()->prepare('SELECT 1 FROM members WHERE email = ?');
        $s->execute([$email]);
        if ($s->fetch()) fail('An account with that email already exists. Log in instead.', 409);
        $name = mb_substr($name, 0, 60, 'UTF-8');
        $insert = db()->prepare('INSERT IGNORE INTO members (email, name, password_hash, created_at) VALUES (?,?,?,?)');
        $insert->execute([$email, $name, password_hash($pass, PASSWORD_DEFAULT), time()]);
        if ($insert->rowCount() !== 1) fail('An account with that email already exists. Log in instead.', 409);
        $memberId = (int)db()->lastInsertId();
        db()->prepare('INSERT INTO login_attempts (ip, created_at) VALUES (?,?)')->execute([$ip, time()]);
        session_regenerate_id(true);
        unset($_SESSION['aid']);
        $_SESSION['mid'] = $memberId;
        $s = db()->prepare('SELECT password_hash FROM members WHERE id = ?');
        $s->execute([$memberId]);
        $_SESSION['member_password_hash'] = $s->fetchColumn();
        out(['member' => current_member()], 201);

    case 'account_login':
        need_post($method);
        $ip = substr($_SERVER['REMOTE_ADDR'] ?? '', 0, 45);
        db()->prepare('DELETE FROM login_attempts WHERE created_at < ?')->execute([time() - 900]);
        $s = db()->prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?');
        $s->execute([$ip]);
        if ((int)$s->fetch()['n'] >= 10) fail('Too many login attempts. Wait 15 minutes and try again.', 429);

        $email = strtolower(trim((string)($in['email'] ?? '')));
        $pass = (string)($in['password'] ?? '');
        $s = db()->prepare('SELECT id, password_hash FROM members WHERE email = ?');
        $s->execute([$email]);
        $member = $s->fetch();
        $hash = $member ? $member['password_hash'] : '$2b$10$XH7o19SQFxtIx0J2q1ovaOKTlIT.gLbjzUN/QXJpSA1d4LPoZqmmG';
        $ok = password_verify($pass, $hash);
        if (!$member || !$ok) {
            db()->prepare('INSERT INTO login_attempts (ip, created_at) VALUES (?,?)')->execute([$ip, time()]);
            fail('Wrong email or password. Check both and try again.', 401);
        }
        db()->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([$ip]);
        session_regenerate_id(true);
        unset($_SESSION['aid']);
        $_SESSION['mid'] = (int)$member['id'];
        $_SESSION['member_password_hash'] = $member['password_hash'];
        out(['member' => current_member()]);

    case 'account_forgot_password':
        need_post($method);
        $baseUrl = rtrim((string)APP_URL, '/');
        $urlParts = $baseUrl !== '' ? parse_url($baseUrl) : false;
        $localHosts = ['localhost', '127.0.0.1', '::1'];
        $validBaseUrl = filter_var($baseUrl, FILTER_VALIDATE_URL)
            && is_array($urlParts)
            && isset($urlParts['scheme'], $urlParts['host'])
            && ($urlParts['scheme'] === 'https' || ($urlParts['scheme'] === 'http' && in_array(strtolower($urlParts['host']), $localHosts, true)))
            && !isset($urlParts['query'])
            && !isset($urlParts['fragment']);
        if (!$validBaseUrl || !filter_var(PASSWORD_RESET_FROM, FILTER_VALIDATE_EMAIL) || !function_exists('mail'))
            fail('Password reset email is not configured. Ask the site administrator for help.', 503);

        $email = strtolower(trim((string)($in['email'] ?? '')));
        $genericMessage = 'If an account uses that email, a password reset link will be sent shortly.';
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190)
            out(['message' => $genericMessage]);

        $ip = substr($_SERVER['REMOTE_ADDR'] ?? '', 0, 45);
        db()->prepare('DELETE FROM password_reset_attempts WHERE created_at < ?')->execute([time() - 3600]);
        $s = db()->prepare('SELECT COUNT(*) AS n FROM password_reset_attempts WHERE ip = ?');
        $s->execute([$ip]);
        if ((int)$s->fetch()['n'] >= 5) fail('Too many reset requests. Wait an hour and try again.', 429);
        db()->prepare('INSERT INTO password_reset_attempts (ip, created_at) VALUES (?,?)')->execute([$ip, time()]);
        db()->prepare('DELETE FROM member_password_resets WHERE expires_at <= ?')->execute([time()]);

        $s = db()->prepare('SELECT id FROM members WHERE email = ?');
        $s->execute([$email]);
        $memberId = $s->fetchColumn();
        if ($memberId !== false) {
            $token = bin2hex(random_bytes(32));
            $tokenHash = hash('sha256', $token);
            $now = time();
            db()->prepare('DELETE FROM member_password_resets WHERE member_id = ? OR expires_at < ?')->execute([$memberId, $now]);
            db()->prepare('INSERT INTO member_password_resets (token_hash, member_id, expires_at, created_at) VALUES (?,?,?,?)')
                ->execute([$tokenHash, $memberId, $now + 3600, $now]);
            $resetUrl = $baseUrl . '/#reset=' . $token;
            $message = "We received a request to reset your NGL MB password.\n\n"
                . "Use this link within one hour to choose a new password:\n"
                . $resetUrl . "\n\n"
                . "If you did not request this, you can ignore this email.";
            $headers = "From: " . PASSWORD_RESET_FROM . "\r\n"
                . "Content-Type: text/plain; charset=UTF-8\r\n"
                . "X-Mailer: NGL MB Confessions";
            if (!mail($email, 'Reset your NGL MB password', $message, $headers)) {
                db()->prepare('DELETE FROM member_password_resets WHERE token_hash = ?')->execute([$tokenHash]);
                error_log('NGL MB: Password reset email could not be sent.');
                fail('We could not send the reset email. Please try again later.', 503);
            }
        }
        out(['message' => $genericMessage]);

    case 'account_reset_password':
        need_post($method);
        $token = strtolower((string)($in['token'] ?? ''));
        $pass = (string)($in['password'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $token)) fail('This reset link is invalid or has expired.', 400);
        if (strlen($pass) < 8 || strlen($pass) > 72) fail('Password must be 8 to 72 characters long.');

        $pdo->beginTransaction();
        $s = $pdo->prepare('SELECT member_id FROM member_password_resets WHERE token_hash = ? AND expires_at > ? FOR UPDATE');
        $s->execute([hash('sha256', $token), time()]);
        $memberId = $s->fetchColumn();
        if ($memberId === false) {
            $pdo->rollBack();
            fail('This reset link is invalid or has expired.', 400);
        }
        $pdo->prepare('UPDATE members SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($pass, PASSWORD_DEFAULT), $memberId]);
        $pdo->prepare('DELETE FROM member_password_resets WHERE member_id = ?')->execute([$memberId]);
        $pdo->commit();
        if (isset($_SESSION['mid']) && (int)$_SESSION['mid'] === (int)$memberId)
            unset($_SESSION['mid'], $_SESSION['member_password_hash']);
        out(['ok' => true]);

    case 'account_logout':
        need_post($method);
        unset($_SESSION['mid'], $_SESSION['member_password_hash']);
        out(['ok' => true]);

    case 'me':
        out(['admin' => current_admin()]);

    case 'login':
        need_post($method);
        $ip = substr($_SERVER['REMOTE_ADDR'] ?? '', 0, 45);
        db()->prepare('DELETE FROM login_attempts WHERE created_at < ?')->execute([time() - 900]);
        $s = db()->prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?');
        $s->execute([$ip]);
        if ((int)$s->fetch()['n'] >= 10) fail('Too many login attempts. Wait 15 minutes and try again.', 429);

        $email = strtolower(trim((string)($in['email'] ?? '')));
        $pass  = (string)($in['password'] ?? '');
        $s = db()->prepare('SELECT id, password_hash FROM admins WHERE email = ?');
        $s->execute([$email]);
        $a = $s->fetch();
        // Always run a hash check so response time doesn't reveal which emails exist.
        $hash = $a ? $a['password_hash'] : '$2b$10$XH7o19SQFxtIx0J2q1ovaOKTlIT.gLbjzUN/QXJpSA1d4LPoZqmmG';
        $ok = password_verify($pass, $hash);
        if (!$a || !$ok) {
            db()->prepare('INSERT INTO login_attempts (ip, created_at) VALUES (?,?)')->execute([$ip, time()]);
            fail('Wrong email or password. Check both and try again.', 401);
        }
        db()->prepare('DELETE FROM login_attempts WHERE ip = ?')->execute([$ip]);
        session_regenerate_id(true);
        $_SESSION['aid'] = (int)$a['id'];
        out(['admin' => current_admin()]);

    case 'logout':
        need_post($method);
        $_SESSION = [];
        session_destroy();
        out(['ok' => true]);

    /* ---------- Admin only ---------- */
    case 'admin_password_reset':
        need_post($method); $me = need_admin();
        $current = (string)($in['currentPassword'] ?? $in['current_password'] ?? $in['current'] ?? '');
        $next = (string)($in['newPassword'] ?? $in['password'] ?? $in['next'] ?? '');
        if ($current === '') fail('Enter your current password.');
        if (strlen($next) < 8 || strlen($next) > 72) fail('New password must be 8 to 72 characters long.');
        $s = db()->prepare('SELECT password_hash FROM admins WHERE id = ?');
        $s->execute([$me['id']]);
        $hash = $s->fetchColumn();
        if (!$hash || !password_verify($current, $hash)) fail('Current password is wrong.', 401);
        db()->prepare('UPDATE admins SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($next, PASSWORD_DEFAULT), $me['id']]);
        out(['ok' => true]);

    case 'ngl_save':
        need_post($method); $me = need_admin();
        $link = trim((string)($in['link'] ?? ''));
        $parts = parse_url($link);
        $host = strtolower($parts['host'] ?? '');
        $path = $parts['path'] ?? '';
        if (!in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true) || !in_array($host, ['ngl.link', 'www.ngl.link'], true) ||
            !preg_match('#^/[A-Za-z0-9._-]+/?$#', $path))
            fail('Paste a full NGL link, like https://ngl.link/yourusername');
        $link = 'https://ngl.link/' . trim($path, '/') . '/';
        db()->prepare('UPDATE admins SET ngl_link = ? WHERE id = ?')->execute([$link, $me['id']]);
        out(['ngl' => $link]);

    case 'post_create':
        need_post($method); $me = need_admin();
        $text = trim((string)($in['text'] ?? ''));
        if (mb_strlen($text, 'UTF-8') > 2000) fail('Keep confessions under 2000 characters.');
        $photo = parse_photo($in['photo'] ?? null);
        if ($text === '' && $photo === null) fail('Write a confession or choose a photo first.');
        db()->prepare('INSERT INTO posts (body, photo, admin_id, created_at) VALUES (?,?,?,?)')
            ->execute([$text, $photo, $me['id'], (int)round(microtime(true) * 1000)]);
        out(['id' => (int)db()->lastInsertId()], 201);

    case 'post_update':
        need_post($method); need_admin();
        $id = (int)($in['id'] ?? 0);
        $text = trim((string)($in['text'] ?? ''));
        if (mb_strlen($text, 'UTF-8') > 2000) fail('Keep confessions under 2000 characters.');
        $s = db()->prepare('SELECT photo FROM posts WHERE id = ?');
        $s->execute([$id]);
        $existing = $s->fetch();
        if (!$existing) fail('Confession not found.', 404);
        $photo = !empty($in['removePhoto']) ? null
            : (array_key_exists('photo', $in) && $in['photo'] !== '' ? parse_photo($in['photo']) : $existing['photo']);
        if ($text === '' && $photo === null) fail('Write a confession or attach a photo first.');
        db()->prepare('UPDATE posts SET body = ?, photo = ? WHERE id = ?')->execute([$text, $photo, $id]);
        if ($existing['photo'] && $photo !== $existing['photo']) remove_photo($existing['photo']);
        out(['ok' => true]);

    case 'post_delete':
        need_post($method); need_admin();
        $id = (int)($in['id'] ?? 0);
        $s = db()->prepare('SELECT photo FROM posts WHERE id = ?');
        $s->execute([$id]);
        $post = $s->fetch();
        db()->prepare('DELETE FROM posts WHERE id = ?')->execute([$id]);
        if ($post) remove_photo($post['photo']);
        out(['ok' => true]);

    case 'admins':
        need_admin();
        out(db()->query('SELECT id, email, name, ngl_link AS ngl FROM admins ORDER BY id')->fetchAll());

    case 'admin_add':
        need_post($method); need_admin();
        $email = strtolower(trim((string)($in['email'] ?? '')));
        $name  = trim((string)($in['name'] ?? ''));
        $pass  = (string)($in['password'] ?? '');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail('Enter a valid email address.');
        if (strlen($pass) < 8) fail('Password needs at least 8 characters.');
        if ($name === '') $name = 'Admin';
        $name = mb_substr($name, 0, 60, 'UTF-8');
        $s = db()->prepare('SELECT 1 FROM admins WHERE email = ?');
        $s->execute([$email]);
        if ($s->fetch()) fail('That email is already an admin.', 409);
        db()->prepare('INSERT INTO admins (email, name, password_hash, created_at) VALUES (?,?,?,?)')
            ->execute([$email, $name, password_hash($pass, PASSWORD_DEFAULT), time()]);
        out(['ok' => true], 201);

    case 'admin_delete':
        need_post($method); $me = need_admin();
        $id = (int)($in['id'] ?? 0);
        if ($id === $me['id']) fail("You can't remove your own account.");
        db()->prepare('DELETE FROM admins WHERE id = ?')->execute([$id]);
        out(['ok' => true]);

    default:
        fail('Not found.', 404);
    }
} catch (Throwable $e) {
    error_log('NGL MB: ' . $e->getMessage());
    $msg = 'Server error. Make sure MySQL is running in XAMPP and you ran install.php.';
    fail($msg, 500);
}
