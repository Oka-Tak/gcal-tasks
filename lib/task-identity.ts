export interface TaskIdentity {
  account: string;
  tasklist: string;
  googleId: string;
}

export interface ChildTaskIdentity extends TaskIdentity {
  parent: string | null;
}

export function taskIdentity(task: TaskIdentity): string {
  return `${task.account}|${task.tasklist}|${task.googleId}`;
}

export function parentTaskIdentity(task: ChildTaskIdentity): string | null {
  return task.parent ? `${task.account}|${task.tasklist}|${task.parent}` : null;
}
