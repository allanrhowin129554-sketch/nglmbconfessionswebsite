<?php
// Local XAMPP defaults are used when hosting environment variables are not set.
// For InfinityFree, set the values below to the MySQL details shown in the control panel.
define('DB_HOST', getenv('NGLMB_DB_HOST') ?: '127.0.0.1');
define('DB_PORT', (int) (getenv('NGLMB_DB_PORT') ?: 3306));
define('DB_NAME', getenv('NGLMB_DB_NAME') ?: 'ngl_mb');
define('DB_USER', getenv('NGLMB_DB_USER') ?: 'root');
define('DB_PASS', getenv('NGLMB_DB_PASS') ?: '');
// Set these environment variables on the host to enable member password recovery.
define('APP_URL', getenv('NGLMB_APP_URL') ?: '');
define('PASSWORD_RESET_FROM', getenv('NGLMB_PASSWORD_RESET_FROM') ?: '');

function db(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $pdo = new PDO(
            'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER,
            DB_PASS,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
    }
    return $pdo;
}
