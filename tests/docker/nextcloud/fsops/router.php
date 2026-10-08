<?php
/**
 * nc-fsops: HTTP endpoint for the b-1 "N actor" (out-of-band server-side file
 * changes), served by PHP's built-in web server:
 *
 *   php -S 0.0.0.0:8080 /opt/fsops/router.php
 *
 * It runs as uid/gid 33 (www-data) and shares /var/www/html with nc-app, so it
 * writes into the Nextcloud data directory directly and then runs
 * `occ files:scan`, exactly like an external process editing the storage.
 *
 * API (JSON in, JSON out; success 200 {"ok":true}, failure {"error":"..."}):
 *   GET  /v1/health
 *   POST /v1/write   {"base":string,"path":string,"content_b64":string}
 *   POST /v1/remove  {"base":string,"path":string}
 *   POST /v1/scan    {"base":string}
 *
 * There is no authentication: the service is only reachable on the run's
 * private Docker network and publishes no port. Single file, no dependencies.
 */

declare(strict_types=1);

const FILES_ROOT = '/var/www/html/data/ncadmin/files';
const OCC = '/var/www/html/occ';
const OCC_CWD = '/var/www/html';
const SCAN_PATH_PREFIX = 'ncadmin/files/';
const BASE_PATTERN = '#^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$#D';
const DIR_MODE = 0770;
const SCAN_ERROR_TAIL = 2000;

final class HttpError extends Exception
{
    public function __construct(public readonly int $status, string $message)
    {
        parent::__construct($message);
    }
}

// Turn every PHP warning/notice (e.g. a failed mkdir or write) into an
// exception so it is reported as a 500 instead of leaking into the response.
ini_set('display_errors', 'stderr');
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

function bad_request(string $message): HttpError
{
    return new HttpError(400, $message);
}

/** @return array<string, mixed> */
function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        throw bad_request('request body must be a JSON object');
    }
    try {
        $data = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        throw bad_request('invalid JSON: ' . $e->getMessage());
    }
    if (!is_array($data) || ($data !== [] && array_is_list($data))) {
        throw bad_request('request body must be a JSON object');
    }
    return $data;
}

/** @param array<string, mixed> $body */
function require_string(array $body, string $key): string
{
    if (!array_key_exists($key, $body) || !is_string($body[$key])) {
        throw bad_request("\"$key\" must be a string");
    }
    return $body[$key];
}

/** @param array<string, mixed> $body */
function require_base(array $body): string
{
    $base = require_string($body, 'base');
    if (preg_match(BASE_PATTERN, $base) !== 1) {
        throw bad_request('"base" must match ' . BASE_PATTERN);
    }
    foreach (explode('/', $base) as $segment) {
        if ($segment === '.' || $segment === '..') {
            throw bad_request('"base" must not contain "." or ".." segments');
        }
    }
    return $base;
}

/** @param array<string, mixed> $body */
function require_rel_path(array $body): string
{
    $path = require_string($body, 'path');
    if ($path === '') {
        throw bad_request('"path" must not be empty');
    }
    if (str_contains($path, "\0")) {
        throw bad_request('"path" must not contain NUL');
    }
    if ($path[0] === '/') {
        throw bad_request('"path" must be relative');
    }
    foreach (explode('/', $path) as $segment) {
        if ($segment === '..') {
            throw bad_request('"path" must not contain ".." segments');
        }
        if ($segment === '' || $segment === '.') {
            throw bad_request('"path" must not contain empty or "." segments');
        }
    }
    return $path;
}

function files_root(): string
{
    $root = realpath(FILES_ROOT);
    if ($root === false || !is_dir($root)) {
        throw new HttpError(500, FILES_ROOT . ' does not exist');
    }
    return $root;
}

function is_inside(string $root, string $resolved): bool
{
    return $resolved === $root || str_starts_with($resolved, $root . '/');
}

/**
 * Fail with 400 unless the deepest existing ancestor of $dir (inclusive)
 * resolves, symlinks included, to a location inside $root.
 */
function assert_existing_ancestor_inside(string $root, string $dir): void
{
    $probe = $dir;
    while (!file_exists($probe)) {
        $up = dirname($probe);
        if ($up === $probe) {
            break;
        }
        $probe = $up;
    }
    $resolved = realpath($probe);
    if ($resolved === false || !is_inside($root, $resolved)) {
        throw bad_request('resolved path escapes the files root');
    }
}

/**
 * Split "<base>/<path>" into the unresolved parent directory and the final
 * segment. Segments are split on "/" (not basename()) so multibyte names are
 * never mangled by locale handling.
 *
 * @return array{0: string, 1: string}
 */
function split_target(string $root, string $base, string $path): array
{
    $segments = explode('/', $base . '/' . $path);
    $name = array_pop($segments);
    return [$root . '/' . implode('/', $segments), $name];
}

/**
 * Resolve the real parent directory (realpath of the parent + the final
 * segment) and require it to stay inside $root.
 */
function resolve_inside(string $root, string $parent, string $name): string
{
    $realParent = realpath($parent);
    if ($realParent === false || !is_inside($root, $realParent)) {
        throw bad_request('resolved path escapes the files root');
    }
    return $realParent . '/' . $name;
}

/** @return array{ok: true} */
function handle_health(): array
{
    return ['ok' => true];
}

/** @return array{ok: true} */
function handle_write(): array
{
    $body = read_json_body();
    $base = require_base($body);
    $path = require_rel_path($body);
    $content = base64_decode(require_string($body, 'content_b64'), true);
    if ($content === false) {
        throw bad_request('"content_b64" is not valid base64');
    }

    $root = files_root();
    [$parent, $name] = split_target($root, $base, $path);
    assert_existing_ancestor_inside($root, $parent);
    if (!is_dir($parent)) {
        $previous = umask(0);
        try {
            mkdir($parent, DIR_MODE, true);
        } finally {
            umask($previous);
        }
    }
    $target = resolve_inside($root, $parent, $name);
    if (is_dir($target) && !is_link($target)) {
        throw new HttpError(500, 'target is a directory');
    }
    file_put_contents($target, $content, LOCK_EX);
    return ['ok' => true];
}

/** Recursively delete $target without following symlinks. */
function remove_tree(string $target): void
{
    if (is_link($target) || !is_dir($target)) {
        unlink($target);
        return;
    }
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($target, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST,
    );
    foreach ($iterator as $entry) {
        /** @var SplFileInfo $entry */
        if ($entry->isDir() && !$entry->isLink()) {
            rmdir($entry->getPathname());
        } else {
            unlink($entry->getPathname());
        }
    }
    rmdir($target);
}

/** @return array{ok: true} */
function handle_remove(): array
{
    $body = read_json_body();
    $base = require_base($body);
    $path = require_rel_path($body);

    $root = files_root();
    [$parent, $name] = split_target($root, $base, $path);
    assert_existing_ancestor_inside($root, $parent);
    if (!is_dir($parent)) {
        return ['ok' => true];
    }
    $target = resolve_inside($root, $parent, $name);
    if (is_link($target) || file_exists($target)) {
        remove_tree($target);
    }
    return ['ok' => true];
}

/** @return array{ok: true} */
function handle_scan(): array
{
    $body = read_json_body();
    $base = require_base($body);

    // argv array: proc_open executes php directly, no shell is involved.
    $argv = ['php', OCC, 'files:scan', '--path=' . SCAN_PATH_PREFIX . $base];
    $descriptors = [
        0 => ['file', '/dev/null', 'r'],
        1 => ['pipe', 'w'],
        2 => ['redirect', 1],
    ];
    $process = proc_open($argv, $descriptors, $pipes, OCC_CWD);
    if (!is_resource($process)) {
        throw new HttpError(500, 'failed to start occ files:scan');
    }
    $output = stream_get_contents($pipes[1]);
    fclose($pipes[1]);
    $exitCode = proc_close($process);
    if ($exitCode !== 0) {
        $tail = substr((string) $output, -SCAN_ERROR_TAIL);
        throw new HttpError(500, $tail !== '' ? $tail : "occ files:scan exited with code $exitCode");
    }
    return ['ok' => true];
}

/** @var array<string, array{0: string, 1: callable(): array<string, mixed>}> $routes */
$routes = [
    '/v1/health' => ['GET', 'handle_health'],
    '/v1/write' => ['POST', 'handle_write'],
    '/v1/remove' => ['POST', 'handle_remove'],
    '/v1/scan' => ['POST', 'handle_scan'],
];

$startedAt = hrtime(true);
$method = (string) ($_SERVER['REQUEST_METHOD'] ?? 'GET');
$requestPath = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (!is_string($requestPath) || $requestPath === '') {
    $requestPath = '/';
}

try {
    if (!isset($routes[$requestPath])) {
        throw new HttpError(404, 'not found');
    }
    [$allowedMethod, $handler] = $routes[$requestPath];
    if ($method !== $allowedMethod) {
        header('Allow: ' . $allowedMethod);
        throw new HttpError(405, 'method not allowed');
    }
    $status = 200;
    $response = $handler();
} catch (HttpError $e) {
    $status = $e->status;
    $response = ['error' => $e->getMessage()];
} catch (Throwable $e) {
    $status = 500;
    $response = ['error' => $e->getMessage()];
}

http_response_code($status);
header('Content-Type: application/json');
echo json_encode($response, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), "\n";

// One access line per request: "<METHOD> <PATH> <STATUS> <ms>ms".
$elapsedMs = intdiv(hrtime(true) - $startedAt, 1_000_000);
$sanitize = static fn (string $s): string => (string) preg_replace('/[^\x21-\x7e]/', '?', $s);
file_put_contents('php://stderr', sprintf("%s %s %d %dms\n", $sanitize($method), $sanitize($requestPath), $status, $elapsedMs));

return true;
