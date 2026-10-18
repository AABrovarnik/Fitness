import type { NextFunction, Request, Response } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.user) {
    res.status(401).json({ error: "Требуется вход." });
    return;
  }
  next();
}

export function requireRole(role: "client" | "admin") {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session.user) {
      res.status(401).json({ error: "Требуется вход." });
      return;
    }
    if (req.session.user.role !== role) {
      res.status(403).json({ error: "Недостаточно прав." });
      return;
    }
    next();
  };
}
