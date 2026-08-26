# Minimal plain-WebDAV server for the b-4 layer. Built from the official httpd image with nothing
# added but mod_dav and one virtual directory — see dav.conf for why the config stays this bare.
FROM httpd:2.4

# The stock image ships these modules compiled but commented out.
RUN sed -i \
      -e 's|^#\(LoadModule dav_module .*\)|\1|' \
      -e 's|^#\(LoadModule dav_fs_module .*\)|\1|' \
      -e 's|^#\(LoadModule auth_basic_module .*\)|\1|' \
      -e 's|^#\(LoadModule authn_file_module .*\)|\1|' \
      -e 's|^#\(LoadModule authn_core_module .*\)|\1|' \
      -e 's|^#\(LoadModule authz_core_module .*\)|\1|' \
      -e 's|^#\(LoadModule authz_user_module .*\)|\1|' \
      conf/httpd.conf \
 && echo 'Include conf/extra/dav.conf' >> conf/httpd.conf

COPY dav.conf conf/extra/dav.conf

# Silences AH00558 so the container log carries only signal.
RUN echo 'ServerName localhost' >> conf/httpd.conf

# Credentials are fixed and meaningless: the server is created and destroyed by the test run and is
# never reachable from outside the host.
# Ownership must match the user httpd drops to, which this image sets to www-data (NOT the `daemon`
# that older httpd builds used). Getting it wrong fails late and obscurely: MKCOL/PUT return 500 with
# only "Could not open the lock database" in the error log, because mod_dav needs DavLockDB writable.
RUN htpasswd -bc /usr/local/apache2/dav.passwd davuser davpass \
 && mkdir -p /var/dav /usr/local/apache2/var \
 && chown -R www-data:www-data /var/dav /usr/local/apache2/var

EXPOSE 80
