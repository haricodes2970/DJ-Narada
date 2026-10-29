import type { DatabaseSync } from "node:sqlite";

export class CategoryStarRepository {
  constructor(private readonly db: DatabaseSync) {}

  isStarred(categoryPath: string): boolean {
    return this.db.prepare("SELECT 1 FROM category_stars WHERE category_path = ?").get(categoryPath) !== undefined;
  }

  list(): string[] {
    return this.db.prepare("SELECT category_path FROM category_stars ORDER BY category_path").all().map((row) => String((row as Record<string, unknown>).category_path));
  }

  toggle(categoryPath: string): boolean {
    if (this.isStarred(categoryPath)) {
      this.db.prepare("DELETE FROM category_stars WHERE category_path = ?").run(categoryPath);
      return false;
    }
    this.db.prepare("INSERT INTO category_stars (category_path, created_at) VALUES (?, ?)").run(categoryPath, new Date().toISOString());
    return true;
  }
}
