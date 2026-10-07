import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { StatementPatch, VisibilityPatch } from '@codearena/contracts';
import type { Request, Response } from 'express';
import { RateLimit } from '../../rate-limit/rate-limit';
import { Roles, SkipCsrf } from '../auth/guards';
import { ValidationService } from '../submissions/validation.service';
import { AdminProblemsService, toPackageFiles, type UploadedPart } from './admin-problems.service';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Setter and admin endpoints (SRS §3.2.2, screen S15). Every route needs at least the setter role;
 * a setter only reaches problems they uploaded (`assertCanManage`), an admin all of them.
 */
@Roles('setter')
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(AdminProblemsService) private readonly problems: AdminProblemsService,
    @Inject(ValidationService) private readonly validation: ValidationService,
  ) {}

  @Get('problems')
  list(@Req() req: Request) {
    return this.problems.list(req.user!);
  }

  @Get('problems/:slug')
  detail(@Req() req: Request, @Param('slug') slug: string) {
    return this.problems.get(slug, req.user!);
  }

  /**
   * A package folder, one multipart part per file named by its package-relative path, plus a `slug`
   * part. It is authenticated by the bearer token alone (no cookie is involved), so it is exempt
   * from the cookie double-submit check: that lets the web app send the large body straight to the
   * API host instead of through the Vercel rewrite.
   */
  @SkipCsrf()
  @RateLimit({ scope: 'admin-upload', perMinute: 20 })
  @Post('problems/packages')
  @HttpCode(201)
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: { fileSize: MAX_FILE_BYTES, files: 400, fields: 4, parts: 410, fieldNameSize: 256 },
    }),
  )
  upload(
    @Req() req: Request,
    @UploadedFiles() files: UploadedPart[] | undefined,
    @Body() body: { slug?: string },
  ) {
    const slug = typeof body?.slug === 'string' ? body.slug : '';
    return this.problems.upload(slug, toPackageFiles(slug, files ?? []), req.user!);
  }

  @Patch('problems/:slug/statement')
  statement(@Req() req: Request, @Param('slug') slug: string, @Body() body: unknown) {
    return this.problems.patchStatement(slug, StatementPatch.parse(body), req.user!);
  }

  @Roles('admin')
  @Patch('problems/:slug/visibility')
  visibility(@Param('slug') slug: string, @Body() body: unknown) {
    return this.problems.setVisibility(slug, VisibilityPatch.parse(body).visibility);
  }

  @Get('problem-versions/:vid/tests')
  tests(@Req() req: Request, @Param('vid') vid: string) {
    return this.problems.tests(vid, req.user!);
  }

  @Get('problem-versions/:vid/tests.tar')
  async testsArchive(
    @Req() req: Request,
    @Param('vid') vid: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = await this.problems.testsArchive(vid, req.user!);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/x-tar',
      'Content-Disposition': 'attachment; filename="tests.tar"',
    });
    return new StreamableFile(body);
  }

  @Get('problem-versions/:vid/tests/:file')
  async testFile(
    @Req() req: Request,
    @Param('vid') vid: string,
    @Param('file') file: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = await this.problems.testFile(vid, file, req.user!);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file}"`,
    });
    return new StreamableFile(body);
  }

  @RateLimit({ scope: 'admin-validate', perMinute: 10 })
  @Post('problem-versions/:vid/validate')
  @HttpCode(201)
  validate(@Req() req: Request, @Param('vid') vid: string) {
    return this.validation.start(vid, req.user!);
  }

  @Get('validation-runs/:id')
  run(@Req() req: Request, @Param('id') id: string) {
    return this.validation.get(id, req.user!);
  }
}
