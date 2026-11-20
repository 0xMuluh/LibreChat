import jwt from 'jsonwebtoken';
import { isValidObjectIdString } from '@librechat/data-schemas';
import type { ChatProjectMethods } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import { workspaceURLs } from './deployment';

interface WorkspaceRequest extends Request {
  user?: { id: string; _id?: { toString(): string } };
}

export function createWorkspaceHandler(
  deps: Pick<ChatProjectMethods, 'getChatProject'>,
): (req: WorkspaceRequest, res: Response) => Promise<Response> {
  return async (req, res) => {
    const userId = req.user?.id ?? req.user?._id?.toString() ?? '';
    const projectId = req.params.projectId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (typeof projectId !== 'string' || !isValidObjectIdString(projectId)) {
      return res.status(400).json({ error: 'Invalid project ID' });
    }
    const secret = process.env.OMICSBASE_AUTH_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'Workspace authentication is not configured' });
    }
    try {
      if (!(await deps.getChatProject(userId, projectId))) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const urls = workspaceURLs();
      const options = {
        algorithm: 'HS256' as const,
        issuer: 'librechat',
        audience: 'omicsbase-openhands',
        subject: userId,
      };
      // The project cookie goes to the notes engine, the launch ticket to Reports; each
      // is signed with that service's own secret.
      const engineSecret = process.env.OMICSBASE_ENGINE_SECRET || secret;
      const session = jwt.sign({ purpose: 'project', project_id: projectId }, engineSecret, {
        ...options,
        expiresIn: '1h',
      });
      const ticket = jwt.sign({ purpose: 'launch', project_id: projectId }, secret, {
        ...options,
        expiresIn: '2m',
      });
      res.cookie(`omicsbase_project_${projectId}`, session, {
        httpOnly: true,
        secure: urls.secureCookies,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 1000,
      });
      res.setHeader('Cache-Control', 'no-store');
      const { secureCookies: _secureCookies, ...publicUrls } = urls;
      return res.json({ ticket, userId, ...publicUrls });
    } catch {
      return res.status(500).json({ error: 'Could not authorize workspace' });
    }
  };
}
