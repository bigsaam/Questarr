import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { type Request, Response, NextFunction } from "express";
import { storage } from "./storage.js";
import { config } from "./config.js";
import { type User } from "@shared/schema";
import crypto from "crypto";
import { logger } from "./logger.js";

const SALT_ROUNDS = 10;

// Cache the JWT secret in memory to avoid DB hits on every request
let cachedJwtSecret: string | null = null;

/**
 * Get the JWT secret.
 * Priority:
 * 1. In-memory cache
 * 2. Environment variable
 * 3. Database system config
 * 4. Generate new secret and store in DB
 */
async function getJwtSecret(): Promise<string> {
  if (cachedJwtSecret) {
    return cachedJwtSecret;
  }

  // If env var is set, use it (override).
  if (config.auth.jwtSecret) {
    logger.info("Using JWT secret from environment variable");
    cachedJwtSecret = config.auth.jwtSecret;
    return cachedJwtSecret;
  }

  // Check DB
  try {
    const dbSecret = await storage.getSystemConfig("jwt_secret");
    if (dbSecret) {
      logger.info("Loaded JWT secret from database");
      cachedJwtSecret = dbSecret;
      return cachedJwtSecret;
    }
  } catch (error) {
    logger.warn("Failed to load JWT secret from database, generating new one: %s", error);
  }

  // Generate new secret
  const newSecret = crypto.randomBytes(64).toString("hex");

  try {
    await storage.setSystemConfig("jwt_secret", newSecret);
    logger.info("Generated and stored new JWT secret in database");
  } catch (error) {
    logger.error("Failed to store JWT secret in database: %s", error);
  }

  cachedJwtSecret = newSecret;

  if (!config.auth.jwtSecret) {
    logger.warn("⚠️  Using generated JWT secret.");
    logger.warn(
      "⚠️  Set JWT_SECRET in your .env file to use a persistent secret across database resets."
    );
  }

  return newSecret;
}

export async function hashPassword(password: string) {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string) {
  return await bcrypt.compare(password, hash);
}

export async function generateToken(user: User) {
  const secret = await getJwtSecret();
  return jwt.sign({ id: user.id, username: user.username }, secret, {
    expiresIn: "7d",
  });
}

function getHeaderValues(req: Request, headerNames: readonly string[]) {
  const values: string[] = [];

  for (const headerName of headerNames) {
    const headerValue = req.headers[headerName];
    if (Array.isArray(headerValue)) {
      values.push(...headerValue.map((item) => item.trim()).filter(Boolean));
    } else if (typeof headerValue === "string" && headerValue.trim().length > 0) {
      values.push(headerValue.trim());
    }
  }

  return values;
}

async function getAuthentikProxyUser(req: Request) {
  if (!config.auth.authentikProxyAuthEnabled) return null;

  const usernames = getHeaderValues(req, config.auth.authentikProxyAuthUsernameHeaders);
  if (usernames.length === 0) return null;

  for (const username of usernames) {
    const user = await storage.getUserByUsername(username);
    if (user) return user;
  }

  if (config.auth.authentikProxyAuthSingleUserFallback) {
    const users = await storage.getAllUsers();
    if (users.length === 1) {
      logger.info(
        "Authentik proxy user did not match a Questarr user; using single-user fallback: %s",
        users[0].username
      );
      return users[0];
    }
  }

  logger.warn("Authentik proxy user not found in Questarr: %s", usernames.join(", "));
  return null;
}

/**
 * Optional authentication middleware. Sets req.user when a valid JWT is present
 * but never blocks the request — unauthenticated callers simply get no req.user.
 */
export async function optionalAuthenticateToken(req: Request, _res: Response, next: NextFunction) {
  try {
    const proxyUser = await getAuthentikProxyUser(req);
    if (proxyUser) {
      req.user = proxyUser;
      return next();
    }
  } catch (error) {
    logger.warn("Authentik proxy optional auth failed: %s", error);
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (token) {
    try {
      const secret = await getJwtSecret();
      const payload = jwt.verify(token, secret) as { id: string; username: string };
      const user = await storage.getUser(payload.id);
      if (user) req.user = user;
    } catch {
      // Invalid token — continue without user context
    }
  }
  next();
}

export async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  try {
    const proxyUser = await getAuthentikProxyUser(req);
    if (proxyUser) {
      req.user = proxyUser;
      return next();
    }
  } catch (error) {
    logger.warn("Authentik proxy auth failed: %s", error);
  }

  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const secret = await getJwtSecret();
    const payload = jwt.verify(token, secret) as { id: string; username: string };
    const user = await storage.getUser(payload.id);

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    req.user = user;
    next();
  } catch {
    return res.status(403).json({ error: "Invalid or expired token" });
  }
}
