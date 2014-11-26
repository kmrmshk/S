var gulp = require('gulp'),
    concat = require('gulp-concat'),
    es6ModuleTranspiler = require("gulp-es6-module-transpiler");

gulp.task('dist', function() {
    gulp.src([
        "src/S.js",
        "src/S.*.js"
    ])
    .pipe(concat("S.js"))
    .pipe(es6ModuleTranspiler({
        type: "bundle"
    }))
    .pipe(gulp.dest("dist"));
});

gulp.task('default', ['dist']);
gulp.watch('src/*.js', ['dist']);